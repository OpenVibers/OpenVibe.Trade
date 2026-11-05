'use strict';
/**
 * The sitemaps' instrument list (server/http/discovery.js): one build serves every request that arrives while it runs,
 * at most 8 gate decisions at once, reused for TRADE_SITEMAP_TTL_MS (production: 10 minutes; 0 rebuilds on every
 * read). Each crawler fetch of /sitemap.xml weighed every index candidate at once: a few queries each, all on the
 * pool, and the SEC list keeps growing.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const WORDS = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

/** A person-written context makes the instrument an index candidate (the gate in server/domain/indexing.js). */
async function publish(t, instrument) {
    return await t.ctx.context.propose({ kind: 'user', editor: true, subject: t.editor.subject }, instrument, {
        body: `The source states this figure. ${WORDS(70)}`, publish: '1',
    });
}

/**
 * Count the queries the list build makes: indexCandidates() once per build and the newest-price lookup once per
 * decision. `holdFirst` (ms) keeps the first candidates query open so concurrent HTTP requests reach the same build.
 */
function watch(db, { holdFirst = 0 } = {}) {
    const seen = { builds: 0, decisions: 0, now: 0, max: 0 };
    const query = db.query.bind(db);
    db.query = async (text, values) => {
        const sql = String(text);
        if (/FROM trade_instruments i WHERE i\.status = 'active' AND/.test(sql)) {
            seen.builds++;
            if (seen.builds === 1 && holdFirst) await new Promise((r) => setTimeout(r, holdFirst));
            return await query(text, values);
        }
        if (/FROM trade_market_observations WHERE instrument_id/.test(sql)) {
            seen.decisions++; seen.now++; seen.max = Math.max(seen.max, seen.now);
            try { await new Promise((r) => setImmediate(r)); return await query(text, values); } finally { seen.now--; }
        }
        return await query(text, values);
    };
    return seen;
}

(async () => {
    const t = await boot();
    try {
        for (let i = 0; i < 20; i++) await publish(t, await t.instrument({ symbol: `T${i}`, name: `Test ${i}` }));
        const seen = watch(t.ctx.store.db, { holdFirst: 100 });

        await check('concurrent fetches share one build, at most 8 decisions at a time; without a TTL the next fetch rebuilds', async () => {
            const [index, map, llms] = await Promise.all([
                t.get('/sitemap.xml'), t.get('/sitemaps/instruments.xml'), t.get('/llms-full.txt'),
            ]);
            assert.deepStrictEqual([index.status, map.status, llms.status], [200, 200, 200]);
            assert.strictEqual(seen.builds, 1, `three fetches, one build (${seen.builds})`);
            assert.strictEqual(seen.decisions, 20, `each instrument weighed once (${seen.decisions})`);
            assert.ok(seen.max >= 2 && seen.max <= 8, `at most 8 decisions at once (saw ${seen.max})`);
            assert.strictEqual((map.text.match(/<loc>/g) || []).length, 20, 'every indexable instrument listed');
            assert.ok(map.text.includes('https://openvibe.trade/i/T19'));
            assert.ok(llms.text.includes('https://openvibe.trade/i/T19'));

            // No TTL (tests, development): the next fetch rebuilds, and the bytes are the same for the same data.
            const again = await t.get('/sitemaps/instruments.xml');
            assert.strictEqual(seen.builds, 2, 'no TTL: rebuilt');
            assert.strictEqual(seen.decisions, 40);
            assert.strictEqual(again.text, map.text, 'the output is unchanged');
        });
    } finally { await t.close(); }

    const c = await boot({ env: { TRADE_SITEMAP_TTL_MS: '600000' } });
    try {
        const first = await c.instrument({ symbol: 'ACME', name: 'Acme Corp' });
        await publish(c, first);
        const seen = watch(c.ctx.store.db, {});

        await check('with TRADE_SITEMAP_TTL_MS the list is reused until it runs out, and the output is unchanged', async () => {
            const map1 = await c.get('/sitemaps/instruments.xml');
            assert.strictEqual(seen.builds, 1);
            assert.strictEqual(seen.decisions, 1);
            // The index and /llms-full.txt read the same list: no second build inside the window.
            assert.strictEqual((await c.get('/sitemap.xml')).status, 200);
            assert.strictEqual((await c.get('/llms-full.txt')).status, 200);
            c.clock.advance(9 * 60 * 1000);
            const map2 = await c.get('/sitemaps/instruments.xml');
            assert.strictEqual(seen.builds, 1, 'reused inside ten minutes');
            assert.strictEqual(seen.decisions, 1);
            assert.strictEqual(map2.text, map1.text);

            // Expired: one rebuild, and the bytes are the same while the data is the same.
            c.clock.advance(2 * 60 * 1000);
            const map3 = await c.get('/sitemaps/instruments.xml');
            assert.strictEqual(seen.builds, 2, 'rebuilt after');
            assert.strictEqual(seen.decisions, 2);
            assert.strictEqual(map3.text, map1.text, 'the output is unchanged');

            // A new indexable instrument appears at the next build, not before.
            const second = await c.instrument({ symbol: 'OTHR', name: 'Other Co' });
            await publish(c, second);
            assert.strictEqual((await c.get('/sitemaps/instruments.xml')).text, map1.text, 'not inside the window');
            c.clock.advance(11 * 60 * 1000);
            const map4 = await c.get('/sitemaps/instruments.xml');
            assert.strictEqual(seen.builds, 3);
            assert.strictEqual((map4.text.match(/<loc>/g) || []).length, 2);
        });
    } finally { await c.close(); }

    done();
})();
