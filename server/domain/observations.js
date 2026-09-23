'use strict';

/**
 * Market observations: one value a source stated for an instrument at a time.
 *
 * Every row carries value (the decimal exactly as stated), unit, currency (when monetary),
 * observed_at (when the value was true, per the source), the source (key, Sources item, URL, the
 * source's own reference) and retrieved_at (when the source was fetched). None of these is ever
 * filled in: a datum without an observation time or a retrieval time is refused, and an instrument
 * without observations shows no number at all.
 *
 * Rows are immutable (SQLite triggers). The same (source_key, source_ref) recorded twice is one
 * observation (a replay answers created: false); the same reference with a DIFFERENT value is a
 * 409 — a source correcting itself sends a new reference, and both stay on record.
 *
 * Recording runs in one transaction with: trade.observation.created, the source's freshness
 * (a retrieval proves a successful fetch), alert evaluation (alerts.onObservation) and the
 * instrument's Search document (the gate's stale_price rule looks at monetary observations).
 */
const { ApiError } = require('../http/errors');
const { newId, iso, parseTime, parseDecimal, invalid, str, httpUrl } = require('./util');

const METRIC_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/;
const UNIT_RE = /^[A-Za-z][A-Za-z0-9/%._-]{0,19}$/;
const SOURCE_KEY_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const FUTURE_SKEW_MS = 5 * 60 * 1000;

function createObservations({ store, ctx }) {
    const { db } = store;
    const q = {
        byId: db.prepare('SELECT * FROM trade_market_observations WHERE id = ?'),
        byRef: db.prepare('SELECT * FROM trade_market_observations WHERE source_key = ? AND source_ref = ?'),
        insert: db.prepare(`INSERT INTO trade_market_observations (id, instrument_id, metric, value, value_num, unit, currency, period, observed_at,
                            source_key, source_item_id, source_url, source_ref, retrieved_at, max_age_sec, recorded_by, recorded_at)
                            VALUES (@id, @instrument_id, @metric, @value, @value_num, @unit, @currency, @period, @observed_at,
                            @source_key, @source_item_id, @source_url, @source_ref, @retrieved_at, @max_age_sec, @recorded_by, @recorded_at)`),
        latest: db.prepare(`SELECT * FROM (
                              SELECT o.*, ROW_NUMBER() OVER (PARTITION BY metric, unit, IFNULL(currency, '') ORDER BY observed_at DESC, recorded_at DESC, id DESC) AS rn
                                FROM trade_market_observations o WHERE instrument_id = ?)
                            WHERE rn = 1 ORDER BY metric, unit`),
        history: db.prepare(`SELECT * FROM trade_market_observations WHERE instrument_id = ? AND (@metric IS NULL OR metric = @metric)
                             AND observed_at < @before ORDER BY observed_at DESC, recorded_at DESC LIMIT @limit`),
        count: db.prepare('SELECT COUNT(*) AS n FROM trade_market_observations WHERE instrument_id = ?'),
    };

    function validate(input, instrument) {
        const metric = str(input.metric, 80, 'metric', { required: true });
        if (!METRIC_RE.test(metric)) throw invalid('metric must start with a letter and use letters, digits, "_", ".", ":" or "-"');
        const value = parseDecimal(input.value);
        if (!value) throw invalid('value must be a finite decimal as the source stated it');
        const unit = str(input.unit, 20, 'unit', { required: true });
        if (!UNIT_RE.test(unit)) throw invalid('unit is malformed');
        const currency = input.currency == null || input.currency === '' ? null : String(input.currency).trim();
        if (currency && !/^[A-Z]{3}$/.test(currency)) throw invalid('currency must be an ISO 4217 code like USD');
        const observedAt = parseTime(input.observed_at);
        if (observedAt == null) throw invalid('observed_at must be the date-time (with zone) the source states for this value', 'observation.time_required');
        const retrievedAt = parseTime(input.retrieved_at);
        if (retrievedAt == null) throw invalid('retrieved_at must be the date-time (with zone) the source was fetched', 'observation.time_required');
        const limit = store.now() + FUTURE_SKEW_MS;
        if (observedAt > limit || retrievedAt > limit) throw invalid('observed_at and retrieved_at cannot be in the future');
        const sourceKey = str(input.source_key, 64, 'source_key', { required: true });
        if (!SOURCE_KEY_RE.test(sourceKey)) throw invalid('source_key must be an OpenVibe.Sources source key');
        const sourceRef = str(input.source_ref, 300, 'source_ref', { required: true });
        const sourceItemId = input.source_item_id == null || input.source_item_id === '' ? null : String(input.source_item_id);
        if (sourceItemId && !/^itm_[0-9A-HJKMNP-TV-Z]{26}$/.test(sourceItemId)) throw invalid('source_item_id must be a Sources item id (itm_…)');
        let maxAge = null;
        if (input.max_age_sec != null && input.max_age_sec !== '') {
            maxAge = Number(input.max_age_sec);
            if (!Number.isInteger(maxAge) || maxAge < 60 || maxAge > 10 * 365 * 86400) throw invalid('max_age_sec must be an integer between 60 and ten years');
        }
        return {
            instrument_id: instrument.id, metric, value: value.text, value_num: value.num, unit, currency,
            period: str(input.period, 40, 'period'), observed_at: observedAt, source_key: sourceKey, source_item_id: sourceItemId,
            source_url: httpUrl(input.source_url, 'source_url'), source_ref: sourceRef, retrieved_at: retrievedAt, max_age_sec: maxAge,
        };
    }

    const same = (a, b) => a.instrument_id === b.instrument_id && a.metric === b.metric && a.value === b.value && a.unit === b.unit
        && (a.currency || null) === (b.currency || null) && a.observed_at === b.observed_at;

    const api = {
        get: (id) => q.byId.get(id) || null,
        count: (instrument) => q.count.get(instrument.id).n,
        latest: (instrument) => q.latest.all(instrument.id),
        history(instrument, { metric = null, before = null, limit = 50 } = {}) {
            const b = parseTime(before);
            return q.history.all(instrument.id, { metric, before: b == null ? Number.MAX_SAFE_INTEGER : b, limit: Math.min(Math.max(Number(limit) || 50, 1), 500) });
        },

        /**
         * → { observation, created }. recordedBy: 'svc:…' or 'usr_…' (who recorded it here).
         */
        record(input, instrument, { recordedBy, traceparent } = {}) {
            if (!instrument || instrument.status !== 'active') throw new ApiError(404, 'instrument.not_found', 'No such active instrument');
            if (!recordedBy) throw new TypeError('recordedBy is required');
            const row = validate(input || {}, instrument);
            return store.tx(() => {
                const existing = q.byRef.get(row.source_key, row.source_ref);
                if (existing) {
                    if (same(existing, row)) return { observation: existing, created: false };
                    throw new ApiError(409, 'observation.conflict', 'This source reference already recorded a different value; a correction needs its own source_ref');
                }
                const id = newId('obs', store.now());
                q.insert.run({ id, ...row, recorded_by: recordedBy, recorded_at: store.now() });
                const obs = q.byId.get(id);
                ctx.outbox.emit({
                    event_type: 'trade.observation.created', actor: actorOf(recordedBy), visibility: 'public', priority: 'low',
                    subject: { type: 'observation', id },
                    payload: {
                        instrument: { id: instrument.id, symbol: instrument.symbol },
                        ...api.dto(obs, { withFreshness: false }),
                    },
                }, { traceparent });
                ctx.freshness.noteRetrieval(obs.source_key, obs.retrieved_at);
                ctx.alerts.onObservation(obs, instrument, { traceparent });
                ctx.indexing.refresh(instrument, { traceparent });
                return { observation: obs, created: true };
            });
        },

        /** Is this observation stale at `now`? Its source's freshness, and its own max age. */
        staleness(obs, now = store.now()) {
            const src = ctx.freshness.view(obs.source_key, now);
            const own = obs.max_age_sec ? obs.observed_at + obs.max_age_sec * 1000 : null;
            const ownStale = own != null && now > own;
            const candidates = [];
            if (src.stale && src.stale_since) candidates.push(Date.parse(src.stale_since));
            if (ownStale) candidates.push(own);
            return {
                stale: src.stale || ownStale,
                stale_since: candidates.length ? iso(Math.min(...candidates)) : null,
                reason: ownStale ? 'value_older_than_max_age' : !src.known ? 'source_unknown' : src.stale ? 'source_stale' : null,
                source: src,
            };
        },

        dto(obs, { withFreshness = true, now = store.now() } = {}) {
            const out = {
                id: obs.id, metric: obs.metric, value: obs.value, unit: obs.unit, currency: obs.currency, period: obs.period,
                observed_at: iso(obs.observed_at), retrieved_at: iso(obs.retrieved_at), recorded_at: iso(obs.recorded_at),
                max_age_sec: obs.max_age_sec,
                source: { key: obs.source_key, item_id: obs.source_item_id, url: obs.source_url, ref: obs.source_ref },
            };
            if (withFreshness) {
                const s = api.staleness(obs, now);
                out.freshness = { stale: s.stale, stale_since: s.stale_since, reason: s.reason, source_status: s.source.status, source_last_success_at: s.source.last_success_at };
            }
            return out;
        },
    };
    return api;
}

function actorOf(by) {
    const s = String(by || '');
    if (s.startsWith('svc:')) return { type: 'service', id: s.slice(4) };
    if (/^usr_/.test(s)) return { type: 'user', id: s };
    return { type: 'service', id: 'trade' };
}

module.exports = { createObservations, actorOf };
