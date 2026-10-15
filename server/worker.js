'use strict';
/**
 * Background work in the Trade process (two timers):
 *
 *   Sources sync     every TRADE_SYNC_INTERVAL_MS (and early when a signed webhook arrives):
 *                    domain/ingest.js pulls the trade category; idempotent per item revision
 *   freshness        every TRADE_FRESHNESS_INTERVAL_MS: re-evaluate every source on Trade's clock
 *                    (trade.source.stale / recovered on transitions only) and re-send any instrument
 *                    Search document whose gate decision changed (e.g. a price observation aged
 *                    past TRADE_PRICE_MAX_AGE_SEC → noindex)
 *   briefs           every TRADE_BRIEFS_INTERVAL_MS: read SEC's numbers for the companies that filed a report since
 *                    their last read (domain/facts.js, TRADE_SEC_PER_TICK at most), then write AI briefs for the
 *                    companies whose numbers changed (domain/briefs.js, TRADE_BRIEFS_PER_TICK at most, within the
 *                    site's hourly budget)
 */
function createWorker({ config, sync, freshness, indexing, outbox, facts = null, briefs = null, sec = null, log = console }) {
    let syncTimer = null;
    let freshTimer = null;
    let briefsTimer = null;
    let briefsRunning = false;

    async function briefsTick() {
        if (briefsRunning) return null;
        briefsRunning = true;
        const out = { facts: 0, briefs: 0, failed: 0 };
        try {
            if (facts && sec && sec.enabled && config.sec.perTick > 0) {
                for (const i of await facts.due(config.sec.perTick)) {
                    const r = await facts.record(i);
                    if (r.error) out.failed++; else out.facts++;
                }
            }
            if (briefs && briefs.enabled && config.briefs.perTick > 0) {
                const room = Math.max(0, Math.min(config.briefs.perTick, config.briefs.perHour - await briefs.lastHour()));
                for (const i of room ? await briefs.due(room) : []) {
                    try {
                        const r = await briefs.make(i, { trigger: 'report' });
                        if (r.created) out.briefs++;
                    } catch (err) {
                        out.failed++;
                        log.warn(`[Trade] AI brief for ${i.symbol} not made:`, err.message);
                        if (err && err.code === 'brief.budget') break;
                    }
                }
            }
            outbox.kick();
            return out;
        } catch (err) {
            log.error('[Trade] briefs tick failed:', err.message);
            return null;
        } finally { briefsRunning = false; }
    }

    async function freshnessTick() {
        try {
            const changed = await freshness.evaluateAll();
            const docs = await indexing.refreshAll();
            if (changed.length || docs.length) outbox.kick();
            return { sources: changed.length, documents: docs.length };
        } catch (err) {
            log.error('[Trade] freshness tick failed:', err.message);
            return null;
        }
    }

    return {
        freshnessTick,
        briefsTick,
        start() {
            if (!config.worker.enabled) return;
            if (sync.enabled) {
                syncTimer = setInterval(() => sync.run().catch(() => {}), config.sources.syncIntervalMs);
                syncTimer.unref();
                setTimeout(() => sync.run().catch(() => {}), 2000).unref();
            }
            freshTimer = setInterval(freshnessTick, config.worker.freshnessIntervalMs);
            freshTimer.unref();
            if ((sec && sec.enabled) || (briefs && briefs.enabled)) {
                briefsTimer = setInterval(briefsTick, config.briefs.intervalMs);
                briefsTimer.unref();
            }
        },
        stop() { clearInterval(syncTimer); clearInterval(freshTimer); clearInterval(briefsTimer); },
    };
}

module.exports = { createWorker };
