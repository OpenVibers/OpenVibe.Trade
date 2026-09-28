'use strict';
/**
 * Per-actor rate limits (server/http/actor-limits.js, roadmap WS-R task 4): past its limit one caller
 * gets 429 problem+json `rate_limited` with Retry-After, before the route does any work, while another
 * caller still passes; the window reopens on the clock. A first-party service naming a person counts
 * against that person; signed-out reads and a first-party service reading for itself are left to the
 * per-address limit. A form shares its budget with the API route that does the same thing. Health,
 * ready, release.json, metrics and the Events deliveries are never limited; refusals are logged (no
 * token) and counted.
 */
const assert = require('assert');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    // The limiter's clock: 15 s into a minute, so the minute window has 45 s left. Reads: 3 a minute.
    let clock = Date.UTC(2026, 8, 27, 12, 0, 15);
    const logs = [];
    const log = { log() {}, error() {}, warn: (...a) => logs.push(a.join(' ')) };
    const t = await boot({ env: { TRADE_LIMITS_MINUTE: '3', TRADE_LIMITS_HOUR: '100' }, limitsNow: () => clock, log });
    const { alice, bob } = t;
    const svc = t.network.serviceToken('ai', ['trade.watchlist.read', 'trade.watchlist.create']);

    await check('reads: 3 a minute per person, then 429 rate_limited with Retry-After; another person passes', async () => {
        for (let i = 0; i < 3; i++) assert.strictEqual((await t.get('/api/v1/instruments', { as: alice })).status, 200, `read ${i + 1}`);
        const r = await t.get('/api/v1/instruments', { as: alice });
        assert.strictEqual(r.status, 429, r.text);
        assert.strictEqual(r.headers.get('retry-after'), '45');
        assert.strictEqual(r.headers.get('content-type'), 'application/problem+json');
        const p = r.json();
        assert.deepStrictEqual([p.code, p.status, p.retry_after_seconds], ['rate_limited', 429, 45]);
        assert.ok(p.detail.includes('trade.read'), p.detail);
        assert.strictEqual((await t.get('/api/v1/instruments', { as: bob })).status, 200, 'another person still passes');
    });

    await check('a first-party service naming the person counts against them; reading for itself is not counted', async () => {
        const named = await t.get('/api/v1/watchlists', { as: svc, headers: { 'x-ov-subject': alice.subject } });
        assert.deepStrictEqual([named.status, named.json().code], [429, 'rate_limited']);
        for (let i = 0; i < 6; i++) assert.strictEqual((await t.get('/api/v1/instruments', { as: svc })).status, 200, `service read ${i + 1}`);
    });

    await check('signed-out reads keep only the per-address limit (many readers share an address)', async () => {
        for (let i = 0; i < 8; i++) {
            assert.strictEqual((await t.get('/api/v1/instruments', { headers: { 'X-Forwarded-For': '203.0.113.7' } })).status, 200, `signed-out read ${i + 1}`);
            assert.strictEqual((await t.get('/api/v1/sources')).status, 200);
        }
    });

    await check('the next minute opens the window again', async () => {
        clock += 45 * 1000;
        assert.strictEqual((await t.get('/api/v1/instruments', { as: alice })).status, 200);
    });

    await check('watchlists: 10 a minute per person, shared by the API and the form; nothing stored past it', async () => {
        clock = Date.UTC(2026, 8, 27, 12, 5, 0);
        const count = async () => (await t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM trade_watchlists').get()).n;
        for (let i = 0; i < 10; i++) {
            const r = await t.get('/api/v1/watchlists', { as: alice, json: { name: `List ${i}` } });
            assert.strictEqual(r.status, 201, `watchlist ${i + 1}: ${r.text}`);
        }
        const before = await count();
        const form = await t.get('/watchlists', { as: alice, form: { _csrf: t.csrf(alice), name: 'One too many' } });
        assert.deepStrictEqual([form.status, form.json().code, form.headers.get('retry-after')], [429, 'rate_limited', '60']);
        const viaService = await t.get('/api/v1/watchlists', { as: svc, headers: { 'x-ov-subject': alice.subject }, json: { name: 'Relayed' } });
        assert.strictEqual(viaService.status, 429, 'a service creating for the person shares their budget');
        assert.strictEqual(await count(), before, 'nothing stored');
        const other = await t.get('/api/v1/watchlists', { as: bob, json: { name: 'Bob list' } });
        assert.strictEqual(other.status, 201, `another person still creates: ${other.text}`);
    });

    await check('health, ready, release.json, metrics and the Events deliveries are never limited', async () => {
        for (let i = 0; i < 6; i++) {
            assert.strictEqual((await t.get('/api/health')).status, 200);
            assert.notStrictEqual((await t.get('/api/ready')).status, 429);
            assert.strictEqual((await t.get('/release.json')).status, 200);
            assert.strictEqual((await t.get('/metrics')).status, 200);
            const body = JSON.stringify({ event: { event_id: `evt_01JABCDEFGHJKMNPQRSTVWXY${String(i).padStart(2, '0')}`, event_type: 'sources.item.created', payload: {} }, seq: i + 1 });
            const d = await t.get('/internal/events', { method: 'POST', body, headers: { 'content-type': 'application/json', ...signDeliveryHeaders(body, 'hook-secret') } });
            assert.notStrictEqual(d.status, 429, d.text);
        }
    });

    await check('refusals are logged (the caller, never a token) and counted in trade_rate_limited_total', async () => {
        assert.ok(logs.includes(`[Trade] limit trade.read: user:${alice.subject} refused, over 3 per minute`), logs.join('\n'));
        assert.ok(logs.includes(`[Trade] limit trade.watchlist.create: user:${alice.subject} refused, over 10 per minute`), logs.join('\n'));
        assert.ok(!logs.some((l) => /Bearer|eyJ/.test(l)), 'no token in the log');
        const m = (await t.get('/metrics')).text;
        const lines = m.split('\n').filter((l) => l.includes('trade_rate_limited_total')).join('\n');
        assert.ok(/trade_rate_limited_total\{limit="trade.read",window="minute"\} 2/.test(m), lines);
        assert.ok(/trade_rate_limited_total\{limit="trade.watchlist.create",window="minute"\} 2/.test(m), lines);
    });

    await t.close();
    done();
})();
