'use strict';
// public/js/passkey-signin.js — the Sign In control only changes when the browser reports Related Origin
// Requests; a failed ceremony falls back to the ordinary OpenVibe sign-in.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'passkey-signin.js'), 'utf8');

function load({ getClientCapabilities }) {
    const listeners = [], posted = [];
    const ctx = {
        console, setTimeout, clearTimeout,
        btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
        atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        URL, fetch: async (url, opts) => { posted.push({ url, body: opts.body }); return { ok: false, json: async () => ({ error: 'unavailable' }) }; },
        document: { addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture }) },
        location: { origin: 'https://openvibe.deals', hostname: 'openvibe.deals', href: 'https://openvibe.deals/' },
        PublicKeyCredential: getClientCapabilities ? { getClientCapabilities } : {},
    };
    ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
    vm.createContext(ctx);
    vm.runInContext(SCRIPT, ctx);
    return { ctx, listeners, posted };
}

(async () => {
    {
        const { listeners } = load({});
        await new Promise((r) => setImmediate(r));
        assert.equal(listeners.length, 0, 'no PublicKeyCredential.getClientCapabilities: the sign-in is untouched');
    }
    {
        const { listeners } = load({ getClientCapabilities: async () => ({ conditionalGet: true }) });
        await new Promise((r) => setImmediate(r));
        assert.equal(listeners.length, 0, 'no relatedOrigins: the sign-in is untouched');
    }
    {
        const { ctx, listeners, posted } = load({ getClientCapabilities: async () => ({ relatedOrigins: true }) });
        await new Promise((r) => setImmediate(r));
        assert.equal(listeners.length, 1, 'one delegated click listener');
        assert.deepEqual([listeners[0].type, listeners[0].capture], ['click', true]);
        const login = { href: 'https://openvibe.deals/auth/login?next=%2Fdeals', closest: (sel) => (sel === '#openvibe-login-btn' ? login : null) };
        let prevented = 0;
        listeners[0].fn({ target: login, button: 0, preventDefault: () => { prevented += 1; }, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false });
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        assert.equal(prevented, 1, 'the ordinary navigation waits for the ceremony');
        assert.equal(posted[0].url, '/auth/passkey/options', 'the site broker is asked for a ceremony');
        assert.equal(ctx.location.href, login.href, 'a site without the ceremony falls back to the ordinary sign-in');
    }
    console.log('passkey-signin: gated on relatedOrigins, takes the Sign In click, and falls back to the ordinary sign-in');
})().catch((err) => {
    console.error('passkey-signin test failed');
    console.error(String(err.stack).split('\n').slice(0, 5).join('\n'));
    process.exitCode = 1;
});
