'use strict';
/**
 * Static assets follow openvibe-shared/cache-policy (plan T11, lane D): the exact ?v=<assetVersion>
 * a rendered page links is immutable for a year; anything else — a wrong-but-hex ?v=, or none —
 * gets the shared five minutes with a day of stale-while-revalidate. The module owns the strings.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { assetVersion } = require('../server/render/layout');

(async () => {
    const t = await boot();
    const asset = '/css/trade.css';
    const v = assetVersion('css/trade.css');

    await check('the current ?v=<assetVersion> is public, max-age=31536000, immutable', async () => {
        const r = await t.get(`${asset}?v=${v}`);
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    });

    await check('a wrong-but-hex ?v= and no ?v= are public, max-age=300, stale-while-revalidate=86400', async () => {
        for (const p of [`${asset}?v=deadbeefdeadbeef`, asset]) {
            const r = await t.get(p);
            assert.strictEqual(r.status, 200, `${p}: status`);
            assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=300, stale-while-revalidate=86400', `${p}: cache-control`);
        }
    });

    await t.close();
    done();
})();
