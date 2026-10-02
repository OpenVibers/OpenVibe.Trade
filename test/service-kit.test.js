'use strict';
/**
 * server/http/errors.js now sits on openvibe-sdk/service (plan T1): the exports stay put, so these pin
 * the behaviour the hand-rolled helpers promised. The shared JSON body parser answers 413
 * request.too_large for a body over the limit (the hand-rolled one folded that into 400
 * request.invalid_json), malformed JSON is still 400 request.invalid_json, and an ApiError carrying
 * `extra` still answers its status/code/detail with extra spread into the problem body.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { ApiError, asApiError, run } = require('../server/http/errors');

(async () => {
    const t = await boot();
    const svc = t.network.serviceToken('tools', ['trade.watchlist.create']);

    await check('a JSON body over 512 kB is 413 request.too_large, not 400 request.invalid_json', async () => {
        const r = await t.get('/api/v1/watchlists', { as: svc, json: { name: 'Big', padding: 'y'.repeat(600 * 1024) } });
        assert.strictEqual(r.status, 413, r.text);
        assert.strictEqual(r.json().code, 'request.too_large');
    });

    await check('a malformed JSON body is still 400 request.invalid_json', async () => {
        const r = await t.get('/api/v1/watchlists', { as: svc, body: '{"name":', headers: { 'content-type': 'application/json' } });
        assert.strictEqual(r.status, 400, r.text);
        assert.strictEqual(r.json().code, 'request.invalid_json');
    });

    await check('an ApiError with extra answers its status/code/detail and spreads extra', async () => {
        const err = new ApiError(409, 'watchlist.revision_conflict', 'The watchlist changed', { expected: 3, current: 4 });
        assert.strictEqual(asApiError(err), err, 'a branded ApiError maps to itself');

        const res = { statusCode: 0, headers: {}, body: '', headersSent: false, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; } };
        await run(async () => { throw err; })({}, res);

        assert.strictEqual(res.statusCode, 409);
        const b = JSON.parse(res.body);
        assert.strictEqual(b.status, 409);
        assert.strictEqual(b.code, 'watchlist.revision_conflict');
        assert.strictEqual(b.detail, 'The watchlist changed');
        assert.deepStrictEqual({ expected: b.expected, current: b.current }, { expected: 3, current: 4 });
    });

    await t.close();
    done();
})().catch((err) => { console.error(err); process.exit(1); });
