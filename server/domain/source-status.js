'use strict';

/**
 * Freshness per source: is what Trade shows from a source still current?
 *
 * The staleness verdict itself is the ingest chassis's generic rule (openvibe-publishing/ingest,
 * freshness.verdict/view) with Trade's window as the parameter; this module keeps only what is
 * Trade's own — the trade_source_status projection and the trade.source.stale|recovered transitions.
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
const { freshness: fresh, normalize } = require('openvibe-publishing/ingest');
const { iso } = normalize;

function createFreshness({ store, config, outbox }) {
    const { db } = store;
    const def = config.freshness.defaultStaleAfterSec;
    const q = {
        get: db.prepare('SELECT * FROM trade_source_status WHERE source_key = ?'),
        all: db.prepare('SELECT * FROM trade_source_status ORDER BY source_key'),
        ensure: db.prepare(`INSERT INTO trade_source_status (source_key, stale, stale_since, evaluated_at) VALUES (?, 1, ?, NULL) ON CONFLICT DO NOTHING`),
        report: db.prepare(`UPDATE trade_source_status SET name = COALESCE(@name, name), upstream_status = @status,
                            last_success_at = CASE WHEN @last::bigint IS NULL THEN last_success_at WHEN last_success_at IS NULL OR @last > last_success_at THEN @last ELSE last_success_at END,
                            stale_after_sec = COALESCE(@window, stale_after_sec), reported_at = @now,
                            terms_note = COALESCE(@terms, terms_note), license_note = COALESCE(@license, license_note)
                            WHERE source_key = @key`),
        retrieval: db.prepare(`UPDATE trade_source_status SET last_success_at = @at WHERE source_key = @key AND (last_success_at IS NULL OR last_success_at < @at)`),
        mark: db.prepare('UPDATE trade_source_status SET stale = @stale, stale_since = @since, evaluated_at = @now WHERE source_key = @key'),
    };

    /** Pure: the verdict for one status row at `now`. row may be null (unknown source). */
    function verdict(row, now) {
        return fresh.verdict(row, now, def);
    }

    async function view(key, now = store.now()) {
        const row = await q.get.get(key) || null;
        return fresh.view(row, key, now, def);
    }

    async function ensure(key) { await q.ensure.run(key, store.now()); }

    /** Emit on a transition only. Inside the caller's transaction (or its own). */
    async function evaluate(key) {
        return await store.tx(async () => {
            const row = await q.get.get(key);
            if (!row) return null;
            const v = verdict(row, store.now());
            const first = row.evaluated_at == null;
            const was = Boolean(row.stale);
            const since = v.stale ? (v.staleSince != null ? v.staleSince : (row.stale_since || store.now())) : null;
            await q.mark.run({ key, stale: v.stale ? 1 : 0, since, now: store.now() });
            // First sight: a fresh source is not a recovery; a stale one is reported once.
            if (first ? !v.stale : v.stale === was) return null;
            const envelope = await outbox.emit({
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
        async evaluateAll() { return (await Promise.all((await q.all.all()).map(async (r) => await evaluate(r.source_key)))).filter(Boolean); },
        async all(now = store.now()) { return (await Promise.all((await q.all.all()).map(async (r) => await view(r.source_key, now)))); },

        /** What Sources says about a source (its health block). Evaluates the transition. */
        async report(key, { name = null, status = null, lastSuccessAt = null, staleAfterSec = null, termsNote = null, licenseNote = null } = {}) {
            return await store.tx(async () => {
                await ensure(key);
                await q.report.run({ key, name, status, last: lastSuccessAt, window: staleAfterSec, now: store.now(), terms: termsNote, license: licenseNote });
                return await evaluate(key);
            });
        },

        /** A datum retrieved at `at` proves a successful fetch at that time. */
        async noteRetrieval(key, at) {
            await ensure(key);
            await q.retrieval.run({ key, at });
            return await evaluate(key);
        },
    };
}

module.exports = { createFreshness };
