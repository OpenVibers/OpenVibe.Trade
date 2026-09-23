'use strict';
/**
 * ADR-025 acceptance: "No Trade endpoint accepts an order, holds value or gives personalised advice
 * (a route-inventory test in Trade's CI)."
 *
 * Walks the LIVE Express stack of the real app (every router, every mount) and fails if any route
 * path, handler name, capability id or event type carries order / buy / sell / execution / custody /
 * wallet / escrow / checkout / listing semantics (or the close cousins: purchase, payment, payout,
 * deposit, withdraw, cart). Every route outside the shared /auth session layer and /metrics must have a named
 * handler (http/routes.js define()), so a new route cannot slip through anonymously. A negative
 * control proves the checker catches a violating route.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { boot, check, done } = require('./helpers/boot');
const { PROPOSED } = require('../server/auth/capabilities');

const FORBIDDEN = ['order', 'buy', 'sell', 'execut', 'custod', 'wallet', 'escrow', 'checkout', 'listing',
    'purchas', 'payment', 'payout', 'deposit', 'withdraw', 'cart'];

/** Words of a path or identifier: split on non-alphanumerics and camelCase boundaries, lower-cased. */
function words(s) {
    return String(s || '')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/[^A-Za-z0-9]+/)
        .map((w) => w.toLowerCase())
        .filter(Boolean);
}
function violations(s) {
    return words(s).filter((w) => FORBIDDEN.some((f) => w.startsWith(f)));
}

function mountOf(layer) {
    if (!layer.regexp || layer.regexp.fast_slash) return '';
    const src = layer.regexp.source;
    return src.replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/, '').replace(/\\\//g, '/').replace(/\(\?:\(\[\^\\\/]\+\?\)\)/g, ':param');
}

/** Every route in the app: { path, methods, handlers: [names] }. */
function inventory(app) {
    const out = [];
    function walk(stack, prefix) {
        for (const layer of stack) {
            if (layer.route) {
                const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
                for (const p of paths) {
                    out.push({
                        path: prefix + p,
                        methods: Object.keys(layer.route.methods),
                        handlers: layer.route.stack.map((l) => l.handle && l.handle.name).filter((n) => n !== undefined),
                        final: layer.route.stack.length ? layer.route.stack[layer.route.stack.length - 1].handle.name : '',
                    });
                }
            } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
                walk(layer.handle.stack, prefix + mountOf(layer));
            }
        }
    }
    walk(app._router.stack, '');
    return out;
}

(async () => {
    const t = await boot();
    const routes = inventory(t.app);

    await check('the walker sees the real routes (pages, API, discovery, private, editor, webhook, machine)', async () => {
        const paths = new Set(routes.map((r) => r.path));
        for (const p of ['/', '/i/:symbol', '/watchlists', '/editor', '/robots.txt', '/sitemap.xml', '/api/v1/instruments', '/api/v1/alerts', '/api/v1/observations', '/internal/events', '/api/ready', '/auth/login']) {
            assert.ok(paths.has(p), `route ${p} not found in the inventory: ${[...paths].join(' ')}`);
        }
        assert.ok(routes.length >= 50, `only ${routes.length} routes found`);
    });

    await check('no route path carries order/buy/sell/execute/custody/wallet/escrow/checkout/listing semantics', async () => {
        const bad = routes.filter((r) => violations(r.path).length).map((r) => `${r.methods.join(',')} ${r.path} (${violations(r.path).join(', ')})`);
        assert.deepStrictEqual(bad, []);
    });

    await check('no handler name carries those semantics either', async () => {
        const bad = [];
        for (const r of routes) for (const h of r.handlers) if (violations(h).length) bad.push(`${r.path}: ${h}`);
        assert.deepStrictEqual(bad, []);
    });

    await check('every route outside /auth has a named final handler (registered through define())', async () => {
        // /auth/* is the shared Network session layer and /metrics the shared metrics endpoint
        // (openvibe-shared, loopback only); both are checked for paths above like everything else.
        const shared = (p) => p.startsWith('/auth') || p === '/metrics';
        const anon = routes.filter((r) => !shared(r.path) && (!r.final || r.final === 'anonymous' || /^bound /.test(r.final)));
        assert.deepStrictEqual(anon.map((r) => r.path), []);
    });

    await check('no capability id and no produced event type carries those semantics', async () => {
        for (const id of PROPOSED) assert.deepStrictEqual(violations(id), [], id);
        const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'service-manifest-proposal.json'), 'utf8'));
        for (const e of manifest.eventsProduced) assert.deepStrictEqual(violations(e), [], e);
        for (const c of manifest.capabilities) assert.deepStrictEqual(violations(c), [], c);
    });

    await check('no route answers a value-moving verb on an unknown path (the API 404s everything else)', async () => {
        for (const p of ['/api/v1/orders', '/api/v1/instruments/ANY/buy', '/api/v1/wallet', '/api/v1/checkout', '/api/v1/escrow', '/api/v1/listings']) {
            const r = await t.get(p, { method: 'POST', json: {} });
            assert.strictEqual(r.status, 404, `${p} → ${r.status}`);
        }
    });

    await check('negative control: the checker flags a violating route and handler', async () => {
        const bad = express();
        const r = express.Router();
        r.post('/orders', function placeOrder(_req, res) { res.end(); });
        r.get('/portfolio', function sellPosition(_req, res) { res.end(); });
        r.post('/custody/:id', function hold(_req, res) { res.end(); });
        bad.use('/api/v1', r);
        const inv = inventory(bad);
        assert.strictEqual(inv.length, 3);
        assert.ok(violations(inv[0].path).length && violations(inv[0].final).length);
        assert.ok(violations(inv[1].final).length);
        assert.ok(violations(inv[2].path).length);
        // …and does not flag innocent words that merely contain the letters.
        assert.deepStrictEqual(violations('/borders/sorted/reorder-free/watchlists'), []);
    });

    await t.close();
    done();
})();
