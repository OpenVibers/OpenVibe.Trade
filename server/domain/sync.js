'use strict';

/**
 * Pull the trade category from OpenVibe.Sources and record what it states.
 *
 *   1. GET /api/v1/sources            every trade source's health → freshness (report)
 *   2. GET /api/v1/items?category=trade&after=<cursor>&include_removed=1, in change order:
 *        removed item            → the document is hidden (the row stays)
 *        observation item        → an observation (domain/observations.js; idempotent per item revision)
 *        filing / keyed item     → a document (domain/documents.js; new → document alerts)
 *        no instrument matches   → skipped (counted by reason; nothing is created for it)
 *      Each page is applied in one transaction together with the cursor, so a crash replays the
 *      page and every effect is idempotent (UNIQUE keys on observations, documents and deliveries).
 *      The page's per-source health block → freshness as well.
 *
 * A failed call is recorded in trade_sync_state (last_error) and changes nothing else; freshness
 * then decays on Trade's own clock, so pages show the data as stale instead of pretending.
 */
const { mapItem } = require('./mapping');
const { parseTime, iso, json } = require('./util');

const CURSOR = 'sources.trade';

function createSync({ store, config, ctx, sources, log = console }) {
    const { db } = store;
    const q = {
        get: db.prepare('SELECT * FROM trade_sync_state WHERE name = ?'),
        ensure: db.prepare("INSERT OR IGNORE INTO trade_sync_state (name, cursor, counts) VALUES (?, 0, '{}')"),
        advance: db.prepare('UPDATE trade_sync_state SET cursor = @cursor, counts = @counts WHERE name = @name'),
        ok: db.prepare('UPDATE trade_sync_state SET last_ok_at = ?, last_error = NULL WHERE name = ?'),
        fail: db.prepare('UPDATE trade_sync_state SET last_error = ?, last_error_at = ? WHERE name = ?'),
    };
    q.ensure.run(CURSOR);
    let running = null;

    function reportHealth(key, h, extra = {}) {
        if (!h || typeof h !== 'object') return;
        ctx.freshness.report(key, {
            name: extra.name || null,
            status: h.status || null,
            lastSuccessAt: parseTime(h.last_success_at),
            staleAfterSec: Number.isInteger(h.stale_after_sec) ? h.stale_after_sec : null,
            termsNote: extra.terms_note || null,
            licenseNote: extra.license_note || null,
        });
    }

    function resolveKeys(keys) {
        if (keys.cik) {
            const r = ctx.instruments.resolve(keys.cik, { kind: 'cik' });
            if (r.status === 'resolved') return r.instrument;
        }
        if (keys.symbol) {
            const r = ctx.instruments.resolve(keys.symbol, { kind: 'ticker' });
            if (r.status === 'resolved') return r.instrument;
        }
        return null;
    }

    /** Apply one item. → a counter name. Inside the page transaction. */
    function applyItem(item) {
        if (item.removed) return ctx.documents.remove(item.id, { at: parseTime(item.removed.at), reason: item.removed.reason }) ? 'documents_removed' : 'removed_unknown';
        const m = mapItem(item);
        if (m.type === 'skip') return `skipped_${m.reason}`;
        const instrument = resolveKeys(m.keys);
        if (!instrument) return 'skipped_no_matching_instrument';
        if (instrument.status !== 'active') return 'skipped_archived_instrument';
        if (m.type === 'observation') {
            try {
                const r = ctx.observations.record(m.observation, instrument, { recordedBy: 'svc:trade' });
                return r.created ? 'observations_created' : 'observations_unchanged';
            } catch (err) {
                if (err && (err.status === 409 || err.status === 422)) return `skipped_${String(err.code || 'invalid').replace(/\W+/g, '_')}`;
                throw err;
            }
        }
        const r = ctx.documents.upsert(m.document, instrument);
        return r.created ? 'documents_created' : r.changed ? 'documents_updated' : 'documents_unchanged';
    }

    async function runOnce() {
        if (!sources.enabled) return { ok: false, skipped: 'disabled' };
        const summary = { pages: 0, counts: {} };
        try {
            const list = await sources.sources();
            for (const s of (list.sources || [])) {
                if (s && s.category === config.sources.category && s.key) reportHealth(s.key, s.health, s);
            }
            for (let page = 0; page < config.sources.maxPagesPerRun; page++) {
                const state = q.get.get(CURSOR);
                const data = await sources.items({ after: state.cursor, limit: config.sources.pageLimit });
                const items = Array.isArray(data.items) ? data.items : [];
                store.tx(() => {
                    const counts = json(q.get.get(CURSOR).counts, {});
                    for (const item of items) {
                        const k = applyItem(item);
                        counts[k] = (counts[k] || 0) + 1;
                        summary.counts[k] = (summary.counts[k] || 0) + 1;
                    }
                    for (const [key, h] of Object.entries(data.sources || {})) reportHealth(key, h);
                    const next = Number.isInteger(data.next_after) ? data.next_after : state.cursor;
                    q.advance.run({ name: CURSOR, cursor: Math.max(next, state.cursor), counts: JSON.stringify(counts) });
                });
                summary.pages++;
                if (!data.more || !items.length) break;
            }
            q.ok.run(store.now(), CURSOR);
            ctx.outbox.kick();
            return { ok: true, ...summary };
        } catch (err) {
            q.fail.run(String(err.message).slice(0, 500), store.now(), CURSOR);
            log.warn('[Trade] Sources sync failed:', err.message);
            return { ok: false, error: err.message, ...summary };
        }
    }

    return {
        CURSOR,
        enabled: sources.enabled,
        applyItem,
        /** One run at a time; concurrent callers share it. */
        run() {
            if (!running) running = runOnce().finally(() => { running = null; });
            return running;
        },
        state() {
            const s = q.get.get(CURSOR);
            return { enabled: sources.enabled, cursor: s.cursor, last_ok_at: iso(s.last_ok_at), last_error: s.last_error, last_error_at: iso(s.last_error_at), counts: json(s.counts, {}) };
        },
    };
}

module.exports = { createSync };
