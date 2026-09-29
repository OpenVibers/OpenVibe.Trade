'use strict';
/**
 * IndexNow (openvibe-shared/indexnow): INDEXNOW_KEY unset → the feature is off (no key route, nothing
 * sent). With a key, the key file is served at /<key>.txt as text/plain and publishing an indexable
 * instrument page pings the engines with the page's path and the sitemap. A draft never pings.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const KEY = 'k'.repeat(32);
const PAGE = 'https://openvibe.trade/i/ACME';
const WORDS = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

(async () => {
    const off = await boot();
    await check('without a key IndexNow is off: no key route and nothing sent', async () => {
        assert.strictEqual(off.ctx.indexnow.enabled, false);
        const res = await off.get(`/${KEY}.txt`);
        assert.strictEqual(res.status, 404, res.text);
    });
    await off.close();

    const on = await boot({ env: { INDEXNOW_KEY: KEY } });
    await check('with a key the key file answers text/plain with the key', async () => {
        assert.strictEqual(on.ctx.indexnow.enabled, true);
        const res = await on.get(`/${KEY}.txt`);
        assert.strictEqual(res.status, 200, res.text);
        assert.match(res.headers.get('content-type'), /text\/plain/);
        assert.strictEqual(res.text, KEY);
    });
    await on.close();

    // A spy in place of the module's HTTP send: records every pingSoon batch.
    const pings = [];
    const spy = {
        enabled: true,
        keyFile: (_req, _res, next) => next(),
        pingSoon: (urls) => { const a = Array.isArray(urls) ? urls : [urls]; pings.push(...a); return a.length; },
        ping: async () => ({ sent: 0, status: 0 }),
        flush: async () => ({ sent: 0, status: 0 }),
    };
    const t = await boot({ indexnow: spy });
    const acme = await t.instrument({ symbol: 'ACME', name: 'Acme Corp', cik: '1234567' });

    await check('an instrument page that is not indexable never pings', async () => {
        await t.ctx.indexing.refresh(acme);   // active but unreviewed: the gate says noindex
        assert.deepStrictEqual(pings, []);
    });

    await check('a draft never pings', async () => {
        const r = await t.get('/editor/i/ACME/context', { as: t.editor, form: { _csrf: t.csrf(t.editor), body: `Acme is a company. ${WORDS(70)}`, expected_revision: '0' } });
        assert.strictEqual(r.status, 303, r.text);
        assert.deepStrictEqual(pings, []);
    });

    await check('a publish pings the page path and the sitemap', async () => {
        const head = (await t.ctx.context.head(acme)).number;
        const r = await t.get('/editor/i/ACME/context', { as: t.editor, form: { _csrf: t.csrf(t.editor), body: `Acme is a company. ${WORDS(70)}`, expected_revision: String(head), publish: '1' } });
        assert.strictEqual(r.status, 303, r.text);
        assert.ok(pings.includes(PAGE), JSON.stringify(pings));
        assert.ok(pings.includes('https://openvibe.trade/sitemap.xml'), JSON.stringify(pings));
    });

    await check('a retract pings the page and the sitemap again', async () => {
        pings.length = 0;
        const r = await t.get('/editor/i/ACME/context/retract', { as: t.editor, form: { _csrf: t.csrf(t.editor) } });
        assert.strictEqual(r.status, 303, r.text);
        assert.ok(pings.includes(PAGE), JSON.stringify(pings));
        assert.ok(pings.includes('https://openvibe.trade/sitemap.xml'), JSON.stringify(pings));
    });
    await t.close();

    done();
})().catch((err) => { console.error(err); process.exit(1); });
