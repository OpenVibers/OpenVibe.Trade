'use strict';
/**
 * The bounded TTL cache behind /filings (server/http/ttl-cache.js): an entry lives for the TTL, a rewrite refreshes it,
 * and the cache never keeps more than `max` entries however many forms or pages a scanner asks for.
 */
const assert = require('assert');
const { createTtlCache } = require('../server/http/ttl-cache');

(async () => {
    let now = 1_000;
    const cache = createTtlCache({ ttlMs: 100, max: 2, now: () => now });

    assert.strictEqual(cache.get('missing'), undefined, 'nothing cached yet');
    cache.set('a', { n: 1 });
    assert.deepStrictEqual(cache.get('a'), { n: 1 }, 'a fresh entry is served');
    now = 1_099;
    assert.deepStrictEqual(cache.get('a'), { n: 1 }, 'just inside the TTL');
    now = 1_100;
    assert.strictEqual(cache.get('a'), undefined, 'expired at the TTL, not after it');

    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    assert.strictEqual(cache.size, 2, 'bounded by max');
    assert.strictEqual(cache.get('a'), undefined, 'the oldest entry went first');
    assert.strictEqual(cache.get('c'), 3);

    now = 1_150;
    cache.set('b', 4);
    assert.strictEqual(cache.get('b'), 4, 'a rewrite refreshes the value and its clock');
    now = 1_249;
    assert.strictEqual(cache.get('b'), 4, 'the rewrite restarted the TTL');

    cache.clear();
    assert.strictEqual(cache.size, 0, 'clear empties it');
    console.log('all passed');
})().catch((err) => { console.error(err); process.exit(1); });
