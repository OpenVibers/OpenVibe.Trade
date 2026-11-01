'use strict';

/**
 * A small bounded TTL cache for public page data. The clocks are injected so a test can age an entry without sleeping;
 * `max` evicts the oldest entry first, so a scanner asking for many forms and pages cannot grow it without bound.
 *
 * Only data that is the same for every anonymous reader goes in: the /filings listing (form + page) is the first user.
 */
function createTtlCache({ ttlMs, max = 100, now = Date.now } = {}) {
    if (!(ttlMs > 0)) throw new RangeError('ttlMs must be positive');
    if (!(max > 0)) throw new RangeError('max must be positive');
    const entries = new Map();
    return {
        get(key) {
            const hit = entries.get(key);
            if (!hit) return undefined;
            if (now() - hit.at >= ttlMs) { entries.delete(key); return undefined; }
            return hit.value;
        },
        set(key, value) {
            entries.delete(key);   // re-insert so the most recently written is the last to be evicted
            entries.set(key, { at: now(), value });
            while (entries.size > max) entries.delete(entries.keys().next().value);
        },
        clear() { entries.clear(); },
        get size() { return entries.size; },
    };
}

module.exports = { createTtlCache };
