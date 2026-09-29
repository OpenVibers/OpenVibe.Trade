'use strict';

/**
 * Pull the trade category from OpenVibe.Sources and record what it states.
 *
 * The Sources client, the change cursor and the per-page pull loop are the ingest chassis
 * (openvibe-publishing/ingest): one transaction per page (the page's writes and the cursor advance
 * commit together), one savepoint per item, so a crash replays the page and a bad item is isolated.
 * This module keeps only Trade's own half — item mapping, instrument resolution, observations,
 * documents, freshness reporting and the trade_sync_state bookkeeping.
 *
 *   1. GET /api/v1/sources            every trade source's health → freshness (report)
 *   2. GET /api/v1/items?category=trade&after=<cursor>&include_removed=1, in change order:
 *        removed item            → the document is hidden (the row stays)
 *        observation item        → an observation (domain/observations.js; idempotent per item revision)
 *        filing / keyed item     → a document (domain/documents.js; new → document alerts)
 *        no instrument matches   → skipped (counted by reason; nothing is created for it)
 *
 * A failed call is recorded in trade_sync_state (last_error) and changes nothing else; freshness
 * then decays on Trade's own clock, so pages show the data as stale instead of pretending.
 */
const { createChangeCursor, pullChanges, normalize } = require('openvibe-publishing/ingest');
const { mapItem } = require('./mapping');
const { parseTime, iso, json } = normalize;

const PREFIX = 'trade';
const CURSOR = 'sources.trade';

/** The chassis outcome for a domain counter key: a removal is a tombstone, everything else applied. */
const outcomeOf = (key) => (key === 'documents_removed' || key === 'removed_unknown' ? 'removed' : 'applied');

function createIngest({ store, config, ctx, sources, log = console }) {
    const { db } = store;
    const cursor = createChangeCursor(db, { prefix: PREFIX, now: store.now });
    const q = {
        get: db.prepare('SELECT * FROM trade_sync_state WHERE name = ?'),
        ensure: db.prepare("INSERT INTO trade_sync_state (name, cursor, counts) VALUES (?, 0, '{}') ON CONFLICT DO NOTHING"),
        save: db.prepare('UPDATE trade_sync_state SET counts = @counts, last_ok_at = @ok, last_error = NULL WHERE name = @name'),
        fail: db.prepare('UPDATE trade_sync_state SET last_error = ?, last_error_at = ? WHERE name = ?'),
    };
    let ensured = false;   // the state row, written on the first run (not at construction: the factory stays synchronous)
    const ensureState = async () => { if (!ensured) { await q.ensure.run(CURSOR); ensured = true; } };
    let running = null;

    async function reportHealth(key, h, extra = {}) {
        if (!h || typeof h !== 'object') return;
        await ctx.freshness.report(key, {
            name: extra.name || null,
            status: h.status || null,
            lastSuccessAt: parseTime(h.last_success_at),
            staleAfterSec: Number.isInteger(h.stale_after_sec) ? h.stale_after_sec : null,
            termsNote: extra.terms_note || null,
            licenseNote: extra.license_note || null,
        });
    }

    async function resolveKeys(keys) {
        if (keys.cik) {
            const r = await ctx.instruments.resolve(keys.cik, { kind: 'cik' });
            if (r.status === 'resolved') return r.instrument;
        }
        if (keys.symbol) {
            const r = await ctx.instruments.resolve(keys.symbol, { kind: 'ticker' });
            if (r.status === 'resolved') return r.instrument;
        }
        return null;
    }

    /** Apply one item. → a counter name. Inside the page transaction. */
    async function applyItem(item) {
        if (item.removed) return await ctx.documents.remove(item.id, { at: parseTime(item.removed.at), reason: item.removed.reason }) ? 'documents_removed' : 'removed_unknown';
        const m = mapItem(item);
        if (m.type === 'skip') return `skipped_${m.reason}`;
        const instrument = await resolveKeys(m.keys);
        if (!instrument) return 'skipped_no_matching_instrument';
        if (instrument.status !== 'active') return 'skipped_archived_instrument';
        if (m.type === 'observation') {
            try {
                const r = await ctx.observations.record(m.observation, instrument, { recordedBy: 'svc:trade' });
                return r.created ? 'observations_created' : 'observations_unchanged';
            } catch (err) {
                if (err && (err.status === 409 || err.status === 422)) return `skipped_${String(err.code || 'invalid').replace(/\W+/g, '_')}`;
                throw err;
            }
        }
        const r = await ctx.documents.upsert(m.document, instrument);
        return r.created ? 'documents_created' : r.changed ? 'documents_updated' : 'documents_unchanged';
    }

    async function runOnce() {
        if (!sources.enabled) return { ok: false, skipped: 'disabled' };
        await ensureState();
        const summary = { pages: 0, counts: {} };
        const counts = {};
        try {
            const list = await sources.listSources();
            for (const s of (list.sources || [])) {
                if (s && s.category === config.sources.category && s.key) await reportHealth(s.key, s.health, s);
            }
            const pull = await pullChanges({
                db, cursor, source: sources, name: CURSOR,
                maxPages: config.sources.maxPagesPerRun, pageSize: config.sources.pageLimit,
                apply: async (item) => {
                    const key = await applyItem(item);
                    counts[key] = (counts[key] || 0) + 1;
                    return outcomeOf(key);
                },
            });
            summary.pages = pull.pages;
            summary.counts = counts;
            await q.save.run({ name: CURSOR, counts: JSON.stringify(counts), ok: store.now() });
            ctx.outbox.kick();
            return { ok: true, ...summary };
        } catch (err) {
            await q.fail.run(String(err.message).slice(0, 500), store.now(), CURSOR);
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
        async state() {
            await ensureState();
            const s = await q.get.get(CURSOR);
            return { enabled: sources.enabled, cursor: await cursor.get(CURSOR), last_ok_at: iso(s.last_ok_at), last_error: s.last_error, last_error_at: iso(s.last_error_at), counts: json(s.counts, {}) };
        },
    };
}

module.exports = { createIngest, CURSOR };
