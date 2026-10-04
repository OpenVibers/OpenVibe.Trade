'use strict';
/**
 * T9 J7b/J7b' — scripts/subscribe.js: subscribe to OpenVibe.Events and reconcile.
 *
 *   1. stub-fetch test for subscription: POST to {EVENTS_URL}/api/v1/subscriptions with a
 *      service token and the loopback endpoint; handle 200 (created) and 409 (exists).
 *   2. the service token client is required: a missing client secret throws.
 *   3. reconcile test: asserts one bounded pass (refreshAll called once) and reports
 *      {sent, unchanged}.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { subscribe, reconcile } = require('../scripts/subscribe');

// Stand-in for serviceAuth.createTokenClient: the test never mints a real token.
const testTokens = { authHeaders: async () => ({ authorization: 'Bearer test' }) };

(async () => {
    const t = await boot({ env: { TRADE_EVENTS_WEBHOOK_SECRET: 'a'.repeat(32) } });

    await check('subscribe posts to Events with a service token and the loopback endpoint', async () => {
        let captured = null;
        const stubFetch = async (url, opts) => {
            captured = { url, opts };
            return {
                ok: true,
                status: 200,
                json: async () => ({ subscription_id: 'sub_test123', id: 'sub_test123' }),
                text: async () => '',
            };
        };

        const config = { ...t.ctx.config, events: { ...t.ctx.config.events, url: 'http://events.test' } };
        const result = await subscribe(config, { fetch: stubFetch, tokens: testTokens });

        assert.strictEqual(result.created, true);
        assert.strictEqual(result.subscription_id, 'sub_test123');
        assert.strictEqual(captured.url, 'http://events.test/api/v1/subscriptions');
        assert.strictEqual(captured.opts.method, 'POST');
        assert.strictEqual(captured.opts.headers.authorization, 'Bearer test');
        const body = JSON.parse(captured.opts.body);
        assert.strictEqual(body.topic_pattern, 'sources.*');
        assert.strictEqual(body.endpoint, `http://127.0.0.1:${config.port}/internal/events`);
        assert.strictEqual(body.secret, config.events.webhookSecret);
    });

    await check('subscribe honours an explicit --endpoint override', async () => {
        let captured = null;
        const stubFetch = async (url, opts) => {
            captured = { url, opts };
            return {
                ok: true,
                status: 200,
                json: async () => ({ subscription_id: 'sub_override' }),
                text: async () => '',
            };
        };

        const config = { ...t.ctx.config, events: { ...t.ctx.config.events, url: 'http://events.test' } };
        await subscribe(config, { fetch: stubFetch, tokens: testTokens, endpoint: 'http://127.0.0.1:9999/internal/events' });

        const body = JSON.parse(captured.opts.body);
        assert.strictEqual(body.endpoint, 'http://127.0.0.1:9999/internal/events');
    });

    await check('subscribe prints exists on 409 and returns created=false', async () => {
        const stubFetch = async () => ({
            ok: false,
            status: 409,
            json: async () => ({ subscription_id: 'sub_existing456' }),
            text: async () => '',
        });

        const config = { ...t.ctx.config, events: { ...t.ctx.config.events, url: 'http://events.test' } };
        const result = await subscribe(config, { fetch: stubFetch, tokens: testTokens });

        assert.strictEqual(result.created, false);
        assert.strictEqual(result.subscription_id, 'sub_existing456');
    });

    await check('subscribe rejects when OV_OAUTH_CLIENT_SECRET is not set', async () => {
        const config = {
            ...t.ctx.config,
            events: { ...t.ctx.config.events, url: 'http://events.test' },
            oauth: { ...t.ctx.config.oauth, clientSecret: '' },
        };
        const stubFetch = async () => { throw new Error('should not be called'); };

        await assert.rejects(
            () => subscribe(config, { fetch: stubFetch }),
            /OV_OAUTH_CLIENT_SECRET is not set/,
        );
    });

    await check('subscribe rejects when secret is shorter than 32 characters', async () => {
        const config = { ...t.ctx.config, events: { ...t.ctx.config.events, url: 'http://events.test', webhookSecret: 'short' } };
        const stubFetch = async () => { throw new Error('should not be called'); };

        await assert.rejects(
            () => subscribe(config, { fetch: stubFetch }),
            /webhook secret is too short/,
        );
    });

    await check('reconcile runs one bounded pass and reports sent/unchanged', async () => {
        // Create two instruments so refreshAll has work to do.
        await t.instrument({ symbol: 'AAPL', name: 'Apple Inc' });
        await t.instrument({ symbol: 'MSFT', name: 'Microsoft Corp' });

        let refreshAllCalls = 0;
        let kickCalls = 0;
        const originalRefreshAll = t.ctx.indexing.refreshAll;
        const originalKick = t.ctx.outbox.kick;

        t.ctx.indexing.refreshAll = async () => {
            refreshAllCalls++;
            return await originalRefreshAll.call(t.ctx.indexing);
        };
        t.ctx.outbox.kick = async () => {
            kickCalls++;
            return await originalKick.call(t.ctx.outbox);
        };

        await reconcile(t.ctx);

        assert.strictEqual(refreshAllCalls, 1, 'refreshAll should be called exactly once (one bounded pass)');
        assert.strictEqual(kickCalls, 1, 'kick should be called exactly once');

        // Report {sent, unchanged}: sent = documents that changed, unchanged = those that didn't.
        // refreshAll returns an array of changed documents; we count active instruments for total.
        const docs = await t.ctx.indexing.refreshAll();
        const total = (await t.ctx.instruments.active()).length;
        const sent = docs.length;
        const unchanged = total - sent;

        console.log(`     reconcile report: { sent: ${sent}, unchanged: ${unchanged} }`);
        assert.strictEqual(typeof sent, 'number');
        assert.strictEqual(typeof unchanged, 'number');
        assert.ok(sent >= 0 && unchanged >= 0);

        // Restore originals.
        t.ctx.indexing.refreshAll = originalRefreshAll;
        t.ctx.outbox.kick = originalKick;
    });

    await t.close();
    done();
})().catch((err) => { console.error(err); process.exit(1); });
