'use strict';
/**
 * server/http/errors.js now sits on openvibe-sdk/service (plan T1): the exports stay put, so these pin
 * the behaviour the hand-rolled helpers promised. The shared JSON body parser answers 413
 * request.too_large for a body over the limit (the hand-rolled one folded that into 400
 * request.invalid_json), malformed JSON is still 400 request.invalid_json, and an ApiError carrying
 * `extra` still answers its status/code/detail with extra spread into the problem body.
 *
 * server/index.js now stops through openvibe-sdk/service's gracefulStop too (plan T2): the last check
 * spawns the real entry point, holds a request in flight, sends SIGTERM, and pins that the drain
 * answers it with Connection: close and the process exits 0.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { once } = require('events');
const { spawn } = require('child_process');
const { boot, check, done } = require('./helpers/boot');
const { ApiError, asApiError, run } = require('../server/http/errors');

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

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

    await check('SIGTERM drains an in-flight request (Connection: close) and exits 0', async () => {
        // A database of its own, like the perf budget test: the real entry point, nothing shared.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-trade-stop-'));
        const port = await freePort();
        const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
            cwd: path.join(__dirname, '..'),
            env: {
                ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test',
                DATABASE_URL: '', DATABASE_DIRECT_URL: '', VALKEY_URL: '',
                TRADE_PGLITE_DIR: path.join(dir, 'pglite'), TRADE_WORKER: 'off',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let log = '';
        child.stdout.on('data', (d) => { log = (log + d).slice(-4000); });
        child.stderr.on('data', (d) => { log = (log + d).slice(-4000); });
        const agent = new http.Agent({ keepAlive: true });
        try {
            const base = `http://127.0.0.1:${port}`;
            let up = false;
            for (let i = 0; i < 150 && !up; i++) {
                up = await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false);
                if (!up) await new Promise((r) => setTimeout(r, 100));
            }
            assert.ok(up, `the server did not start:\n${log}`);

            // A form POST whose body is held open (the shared urlencoded parser waits for the end):
            // it is in flight when SIGTERM arrives, so the drain must answer it rather than cut it.
            let held = null;
            const inFlight = new Promise((resolve, reject) => {
                const req = http.request(`${base}/watchlists`, {
                    method: 'POST', agent, headers: { 'content-type': 'application/x-www-form-urlencoded' },
                }, (res) => {
                    const chunks = [];
                    res.on('data', (c) => chunks.push(c));
                    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
                    res.on('error', reject);
                });
                req.on('error', reject);
                req.write('_csrf=held');
                held = req;
            });
            await new Promise((r) => setTimeout(r, 300));
            const exited = once(child, 'exit');
            child.kill('SIGTERM');
            held.end('&name=Held');

            const res = await inFlight;
            assert.strictEqual(res.headers.connection, 'close', `in-flight response was not Connection: close: ${JSON.stringify(res.headers)}`);
            assert.ok(res.status >= 300, `an unsigned form POST answered ${res.status}`);
            const [code] = await exited;
            assert.strictEqual(code, 0, `expected exit 0, got ${code}\n${log}`);
            assert.ok(/\[Trade\] SIGTERM: stopping/.test(log), `the service kit did not log the stop:\n${log}`);
        } finally {
            agent.destroy();
            if (child.exitCode === null && child.signalCode === null) {
                child.kill('SIGKILL');
                await once(child, 'exit').catch(() => {});
            }
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    done();
})().catch((err) => { console.error(err); process.exit(1); });
