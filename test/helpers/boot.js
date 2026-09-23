'use strict';
/**
 * Boots Trade on a temp database with a controllable clock and mocks of its neighbours, and
 * returns a small HTTP client. Every test file gets its own instance.
 *
 *   const t = await boot();                 // t.base, t.get(path, { as: user | token, json, form })
 *   t.clock.advance(ms)                     // the app's clock (freshness, gate, alerts)
 *   t.editor, t.alice, t.bob                // Network users (the editor is in TRADE_EDITORS)
 *   t.instrument({ symbol, name, cik })     // create an instrument through the domain (seed for tests)
 *   t.events(type)                          // parsed envelopes in event_outbox
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { startNetwork, startSources } = require('./mocks');

const T0 = Date.parse('2026-09-22T12:00:00Z');

function makeClock(start = T0) {
    let t = start;
    return { now: () => t, advance: (ms) => { t += ms; return t; }, set: (v) => { t = v; } };
}

async function boot(opts = {}) {
    const network = await startNetwork();
    const sources = await startSources({ network });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-trade-test-'));
    const dbPath = path.join(dir, 'trade.db');
    const clock = opts.clock || makeClock();
    const editor = network.addUser('editor');
    const alice = network.addUser('alice');
    const bob = network.addUser('bob');
    const env = {
        NODE_ENV: 'test', PORT: '0', BASE_URL: 'https://openvibe.trade', TRUST_PROXY: '1',
        TRADE_DB_PATH: dbPath,
        OV_NETWORK_URL: network.url, OV_NETWORK_INTERNAL_URL: network.url,
        OV_OAUTH_CLIENT_ID: 'trade', OV_OAUTH_CLIENT_SECRET: 'shh', COOKIE_SECURE: 'false',
        OV_SOURCES_INTERNAL_URL: sources.url,
        TRADE_EDITORS: editor.subject, TRADE_WORKER: 'off', TRADE_FORM_SECRET: 'test-form-secret',
        TRADE_EVENTS_WEBHOOK_SECRET: 'hook-secret',
        ...(opts.env || {}),
    };
    const configLib = require('../../server/config');
    const { createApp } = require('../../server/app');
    const quiet = { log() {}, warn() {}, error: (...a) => { if (process.env.VERBOSE) console.error(...a); } };

    let server = null;
    let built = null;
    async function start() {
        const config = configLib.load(env);
        built = createApp({ config, now: clock.now, log: quiet });
        await built.ctx.auth.ensureKey();
        server = await new Promise((resolve) => { const s = http.createServer(built.app); s.listen(0, '127.0.0.1', () => resolve(s)); });
        t.base = `http://127.0.0.1:${server.address().port}`;
        t.app = built.app;
        t.ctx = built.ctx;
    }
    async function stop() {
        if (server) await new Promise((r) => server.close(r));
        if (built) { built.ctx.worker.stop(); await built.ctx.outbox.stop(); built.ctx.store.close(); }
        server = null; built = null;
    }

    /** as: a network user ({ subject, … }) → ov_token cookie; a string → Bearer token. */
    async function get(p, o = {}) {
        const headers = { ...(o.headers || {}) };
        if (o.as && typeof o.as === 'object') headers.cookie = `ov_token=${network.userToken(o.as)}`;
        if (typeof o.as === 'string') headers.authorization = `Bearer ${o.as}`;
        let body = o.body;
        if (o.json !== undefined) { body = JSON.stringify(o.json); headers['content-type'] = 'application/json'; }
        if (o.form) { body = new URLSearchParams(o.form).toString(); headers['content-type'] = 'application/x-www-form-urlencoded'; }
        const res = await fetch(t.base + p, { method: o.method || (body ? 'POST' : 'GET'), headers, body, redirect: 'manual' });
        const text = await res.text();
        return { status: res.status, headers: res.headers, text, json() { return JSON.parse(text); } };
    }

    function events(type = null) {
        return t.ctx.store.db.prepare('SELECT envelope FROM event_outbox ORDER BY id').all().map((r) => JSON.parse(r.envelope))
            .filter((e) => !type || e.event_type === type || (type instanceof RegExp && type.test(e.event_type)));
    }

    const t = {
        network, sources, clock, dbPath, editor, alice, bob, get, events, T0,
        csrf: (user) => require('../../server/auth/forms').csrfToken({ formSecret: env.TRADE_FORM_SECRET }, user),
        iso: (ms) => new Date(ms).toISOString(),
        instrument(input) { return t.ctx.instruments.create({ kind: 'equity', ...input }, editor.subject); },
        /** Record an observation as a first-party feed would (domain call, recordedBy svc:feed). */
        observe(instrument, input) {
            return t.ctx.observations.record({ source_key: 'test-feed', unit: 'USD', currency: 'USD', ...input }, instrument, { recordedBy: 'svc:feed' });
        },
        async restart() { await stop(); await start(); },
        async close() { await stop(); await network.close(); await sources.close(); fs.rmSync(dir, { recursive: true, force: true }); },
    };
    await start();
    return t;
}

let failures = 0;
async function check(name, fn) {
    try { await fn(); console.log('  ✓', name); } catch (e) { failures++; console.log('  ✗', name, '\n     ', (e.stack || String(e)).split('\n').slice(0, 8).join('\n      ')); }
}
function done() { console.log(failures ? `\n${failures} failed` : '\nall passed'); process.exit(failures ? 1 : 0); }

module.exports = { boot, check, done, makeClock, T0 };
