'use strict';

/**
 * Freshness per source: is what Trade shows from a source still current?
 *
 * A source is FRESH at time `now` only when its last successful fetch is known and younger than its
 * staleness window (Sources' stale_after_sec, else TRADE_DEFAULT_STALE_AFTER_SEC). Everything
 * else is stale:
 *   - the last success is older than the window        → stale since last success + window
 *   - Sources never reported a success                 → stale since Trade first saw the source
 *   - Trade has never heard of the source at all       → freshness unknown (shown as stale)
 * Sources' own health status (failing, disabled, …) is shown next to it, but the verdict is
 * computed with Trade's clock, so an outage of Sources or of the sync makes data go stale on its own
 * rather than look current forever. Nothing is ever replaced by an invented value: a stale value is
 * shown with its timestamps and a "stale since" label, and a missing one is shown as missing.
 *
 * `trade.source.stale` and `trade.source.recovered` are emitted only on a transition (evaluate()),
 * so a replay or a second tick changes nothing.
 */
const { iso } = require('./util');

function createFreshness({ store, config, outbox }) {
    const { db } = store;
    const def = config.freshness.defaultStaleAfterSec;
    const q = {
        get: db.prepare('SELECT * FROM trade_source_status WHERE source_key = ?'),
        all: db.prepare('SELECT * FROM trade_source_status ORDER BY source_key'),
        ensure: db.prepare(`INSERT OR IGNORE INTO trade_source_status (source_key, stale, stale_since, evaluated_at) VALUES (?, 1, ?, NULL)`),
        report: db.prepare(`UPDATE trade_source_status SET name = COALESCE(@name, name), upstream_status = @status,
                            last_success_at = CASE WHEN @last IS NULL THEN last_success_at WHEN last_success_at IS NULL OR @last > last_success_at THEN @last ELSE last_success_at END,
                            stale_after_sec = COALESCE(@window, stale_after_sec), reported_at = @now,
                            terms_note = COALESCE(@terms, terms_note), license_note = COALESCE(@license, license_note)
                            WHERE source_key = @key`),
        retrieval: db.prepare(`UPDATE trade_source_status SET last_success_at = @at WHERE source_key = @key AND (last_success_at IS NULL OR last_success_at < @at)`),
        mark: db.prepare('UPDATE trade_source_status SET stale = @stale, stale_since = @since, evaluated_at = @now WHERE source_key = @key'),
    };

    /** Pure: the verdict for one status row at `now`. row may be null (unknown source). */
    function verdict(row, now) {
        if (!row) return { known: false, stale: true, staleSince: null, window: def, lastSuccessAt: null };
        const window = row.stale_after_sec || def;
        if (row.last_success_at == null) return { known: true, stale: true, staleSince: row.stale_since, window, lastSuccessAt: null };
        const until = row.last_success_at + window * 1000;
        return { known: true, stale: now > until, staleSince: now > until ? until : null, window, lastSuccessAt: row.last_success_at };
    }

    function view(key, now = store.now()) {
        const row = q.get.get(key) || null;
        const v = verdict(row, now);
        return {
            key,
            name: row ? row.name : null,
            known: v.known,
            status: !v.known ? 'unknown' : v.stale ? 'stale' : 'fresh',
            stale: v.stale,
            stale_since: iso(v.staleSince),
            last_success_at: iso(v.lastSuccessAt),
            stale_after_sec: v.window,
            upstream_status: row ? row.upstream_status : null,
            reported_at: row ? iso(row.reported_at) : null,
            terms_note: row ? row.terms_note : null,
            license_note: row ? row.license_note : null,
        };
    }

    function ensure(key) { q.ensure.run(key, store.now()); }

    /** Emit on a transition only. Inside the caller's transaction (or its own). */
    function evaluate(key) {
        return store.tx(() => {
            const row = q.get.get(key);
            if (!row) return null;
            const v = verdict(row, store.now());
            const first = row.evaluated_at == null;
            const was = Boolean(row.stale);
            const since = v.stale ? (v.staleSince != null ? v.staleSince : (row.stale_since || store.now())) : null;
            q.mark.run({ key, stale: v.stale ? 1 : 0, since, now: store.now() });
            // First sight: a fresh source is not a recovery; a stale one is reported once.
            if (first ? !v.stale : v.stale === was) return null;
            const envelope = outbox.emit({
                event_type: v.stale ? 'trade.source.stale' : 'trade.source.recovered',
                actor: { type: 'service', id: 'trade' }, visibility: 'public', priority: 'low',
                subject: { type: 'source', id: key },
                payload: {
                    source_key: key, stale: v.stale, stale_since: iso(since), last_success_at: iso(v.lastSuccessAt),
                    stale_after_sec: v.window, upstream_status: row.upstream_status || null, evaluated_at: iso(store.now()),
                },
            });
            return envelope;
        });
    }

    return {
        verdict,
        view,
        ensure,
        evaluate,
        evaluateAll() { return q.all.all().map((r) => evaluate(r.source_key)).filter(Boolean); },
        all(now = store.now()) { return q.all.all().map((r) => view(r.source_key, now)); },

        /** What Sources says about a source (its health block). Evaluates the transition. */
        report(key, { name = null, status = null, lastSuccessAt = null, staleAfterSec = null, termsNote = null, licenseNote = null } = {}) {
            return store.tx(() => {
                ensure(key);
                q.report.run({ key, name, status, last: lastSuccessAt, window: staleAfterSec, now: store.now(), terms: termsNote, license: licenseNote });
                return evaluate(key);
            });
        },

        /** A datum retrieved at `at` proves a successful fetch at that time. */
        noteRetrieval(key, at) {
            ensure(key);
            q.retrieval.run({ key, at });
            return evaluate(key);
        },
    };
}

module.exports = { createFreshness };
