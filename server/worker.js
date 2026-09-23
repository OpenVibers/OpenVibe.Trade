'use strict';
/**
 * Background work in the Trade process (two timers):
 *
 *   Sources sync     every TRADE_SYNC_INTERVAL_MS (and early when a signed webhook arrives):
 *                    domain/sync.js pulls the trade category; idempotent per item revision
 *   freshness        every TRADE_FRESHNESS_INTERVAL_MS: re-evaluate every source on Trade's clock
 *                    (trade.source.stale / recovered on transitions only) and re-send any instrument
 *                    Search document whose gate decision changed (e.g. a price observation aged
 *                    past TRADE_PRICE_MAX_AGE_SEC → noindex)
 */
function createWorker({ config, sync, freshness, indexing, outbox, log = console }) {
    let syncTimer = null;
    let freshTimer = null;

    function freshnessTick() {
        try {
            const changed = freshness.evaluateAll();
            const docs = indexing.refreshAll();
            if (changed.length || docs.length) outbox.kick();
            return { sources: changed.length, documents: docs.length };
        } catch (err) {
            log.error('[Trade] freshness tick failed:', err.message);
            return null;
        }
    }

    return {
        freshnessTick,
        start() {
            if (!config.worker.enabled) return;
            if (sync.enabled) {
                syncTimer = setInterval(() => sync.run().catch(() => {}), config.sources.syncIntervalMs);
                syncTimer.unref();
                setTimeout(() => sync.run().catch(() => {}), 2000).unref();
            }
            freshTimer = setInterval(freshnessTick, config.worker.freshnessIntervalMs);
            freshTimer.unref();
        },
        stop() { clearInterval(syncTimer); clearInterval(freshTimer); },
    };
}

module.exports = { createWorker };
