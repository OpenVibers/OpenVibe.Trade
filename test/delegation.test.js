'use strict';
/**
 * Third-party principals: a developer app (app:…) or module (mod:…) token acts only for the person
 * in its on_behalf_of claim. X-OV-Subject naming anyone else is refused (403 subject.not_delegated),
 * and so are sandbox tokens (401 token.sandbox_refused). First-party services (svc:…) still name the
 * person they act for.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const APP = 'app:app_01J8ZQ4Y7N3M2K1H0G9F8E7D6C';
const MOD = 'mod:mod_01J8ZQ4Y7N3M2K1H0G9F8E7D6C';

(async () => {
    const t = await boot();
    const caps = ['trade.watchlist.read', 'trade.watchlist.create'];
    const token = (sub, actorType, extra) => t.network.signService({ sub, actorType, aud: ['openvibe.trade'], cap: caps, extra });
    const secret = t.ctx.watchlists.create(t.alice.subject, { name: 'Alice secret plans' });

    await check('an app or module cannot read or write someone else\'s watchlists by naming them in X-OV-Subject', async () => {
        for (const [sub, type] of [[APP, 'app'], [MOD, 'mod']]) {
            for (const extra of [{ on_behalf_of: t.bob.subject }, {}]) {
                const read = await t.get('/api/v1/watchlists', { as: token(sub, type, extra), headers: { 'x-ov-subject': t.alice.subject } });
                assert.strictEqual(read.status, 403, `${type} ${JSON.stringify(extra)}: ${read.text}`);
                assert.strictEqual(read.json().code, 'subject.not_delegated');
                assert.doesNotMatch(read.text, /secret plans/);
                const one = await t.get(`/api/v1/watchlists/${secret.id}`, { as: token(sub, type, extra), headers: { 'x-ov-subject': t.alice.subject } });
                assert.strictEqual(one.status, 403);
                const write = await t.get('/api/v1/watchlists', { as: token(sub, type, extra), headers: { 'x-ov-subject': t.alice.subject }, json: { name: 'Planted' } });
                assert.strictEqual(write.status, 403);
            }
        }
        assert.deepStrictEqual(t.ctx.watchlists.forOwner(t.alice.subject).map((w) => w.name), ['Alice secret plans']);
    });

    await check('an app acts for its on_behalf_of person (the header is optional and must match)', async () => {
        const bobApp = token(APP, 'app', { on_behalf_of: t.bob.subject });
        const c = await t.get('/api/v1/watchlists', { as: bobApp, json: { name: 'Bob via app' } });
        assert.strictEqual(c.status, 201, c.text);
        const list = await t.get('/api/v1/watchlists', { as: bobApp, headers: { 'x-ov-subject': t.bob.subject } });
        assert.strictEqual(list.status, 200, list.text);
        assert.deepStrictEqual(list.json().watchlists.map((w) => w.name), ['Bob via app']);
        assert.strictEqual((await t.get(`/api/v1/watchlists/${secret.id}`, { as: bobApp })).status, 404, 'not bob\'s');
    });

    await check('sandbox app tokens are refused', async () => {
        const r = await t.get('/api/v1/watchlists', { as: token(APP, 'app', { on_behalf_of: t.alice.subject, env: 'sandbox' }) });
        assert.strictEqual(r.status, 401);
        assert.strictEqual(r.json().code, 'token.sandbox_refused');
    });

    await check('first-party services still name the person they act for', async () => {
        const r = await t.get('/api/v1/watchlists', { as: t.network.serviceToken('tools', caps), headers: { 'x-ov-subject': t.alice.subject } });
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual(r.json().watchlists.map((w) => w.name), ['Alice secret plans']);
    });

    await t.close();
    done();
})();
