'use strict';
/**
 * In-process stand-ins for Trade's neighbours, with a real RS256 key pair:
 *   Network  JWKS, /oauth/token (client_credentials → service tokens with the requested scope as
 *            capabilities)
 *   Sources  GET /api/v1/sources and GET /api/v1/items (sources.item@1 shape, change order,
 *            include_removed), gated on the capabilities; the test controls items, health and outages
 * userToken()/serviceToken() mint the tokens browsers and services present to Trade.
 */
const http = require('http');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { serviceAuth, ids } = require('openvibe-contracts');

function listen(handler) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
                handler(req, raw, json, res);
            });
        });
        server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) }));
    });
}

async function startNetwork() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const grants = [];
    let issuer = null;
    const srv = await listen((req, raw, json) => {
        if (req.url === '/api/.well-known/jwks') return json(200, { public_key: publicPem, algorithm: 'RS256' });
        if (req.url === '/oauth/token' && req.method === 'POST') {
            let body = {};
            if (String(req.headers['content-type'] || '').includes('application/x-www-form-urlencoded')) body = Object.fromEntries(new URLSearchParams(raw));
            else { try { body = JSON.parse(raw); } catch { /* */ } }
            grants.push(body);
            if (body.client_secret !== 'shh') return json(401, { error: 'invalid_client' });
            if (body.grant_type === 'client_credentials') {
                let scope = body.scope;
                if (scope && typeof scope === 'object') scope = Object.values(scope).join(' ');
                const cap = String(scope || '').split(/\s+/).filter(Boolean);
                return json(200, { access_token: signService({ sub: `svc:${body.client_id}`, aud: [body.audience || 'openvibe.events'], cap }), token_type: 'Bearer', expires_in: 300 });
            }
            return json(400, { error: 'unsupported_grant_type' });
        }
        return json(404, { error: 'not found' });
    });
    issuer = srv.url;
    function signService({ sub, aud, cap }) {
        return serviceAuth.signServiceToken({ iss: issuer, sub, actor_type: 'service', aud, cap, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, jti: crypto.randomUUID() }, privatePem);
    }
    function addUser(username, extra = {}) {
        return { subject: ids.newId('user'), username, display_name: extra.display_name || username, role: extra.role || 'user' };
    }
    function userToken(u) {
        return jwt.sign({ sub: String(Math.floor(Math.random() * 1e6)), subject_id: u.subject, username: u.username, display_name: u.display_name, role: u.role || 'user' }, privatePem, { algorithm: 'RS256', issuer, expiresIn: '1h' });
    }
    function serviceToken(client, cap) {
        return signService({ sub: `svc:${client}`, aud: ['openvibe.trade'], cap });
    }
    return { ...srv, publicPem, grants, addUser, userToken, serviceToken, signService };
}

/** A stand-in for OpenVibe.Sources' read API. */
async function startSources({ network }) {
    const items = [];          // { ...item, change_seq }
    const sources = new Map(); // key → source view
    const calls = [];
    let seq = 0;
    let down = false;
    const srv = await listen((req, raw, json) => {
        calls.push({ method: req.method, url: req.url });
        if (down) return json(503, { code: 'down' });
        const token = String(req.headers.authorization || '').slice(7);
        const v = serviceAuth.verifyServiceToken(token, { publicKey: network.publicPem, issuer: network.url, audience: 'openvibe.sources' });
        if (!v.ok) return json(401, { code: v.code });
        const u = new URL(req.url, 'http://x');
        if (u.pathname === '/api/v1/sources') {
            if (!(v.claims.cap || []).includes('sources.source.read')) return json(403, { code: 'capability.denied' });
            return json(200, { sources: [...sources.values()] });
        }
        if (u.pathname === '/api/v1/items') {
            if (!(v.claims.cap || []).includes('sources.item.read')) return json(403, { code: 'capability.denied' });
            const after = Number(u.searchParams.get('after') || 0);
            const limit = Number(u.searchParams.get('limit') || 100);
            const cat = u.searchParams.get('category');
            const incl = u.searchParams.get('include_removed') === '1';
            const rows = items.filter((i) => i.change_seq > after && (!cat || i.category === cat) && (incl || !i.removed)).sort((a, b) => a.change_seq - b.change_seq);
            const page = rows.slice(0, limit);
            const keys = [...new Set(page.map((i) => i.source_key))];
            const health = {};
            for (const k of keys) if (sources.has(k)) health[k] = sources.get(k).health;
            return json(200, { items: page, next_after: page.length ? page[page.length - 1].change_seq : after, more: rows.length > limit, sources: health });
        }
        return json(404, { code: 'route.not_found' });
    });

    const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
    return {
        ...srv, calls,
        setDown: (d) => { down = d; },
        /** A source with its health block (as GET /api/v1/sources shows it). */
        setSource(key, { name = key, category = 'trade', status = 'healthy', lastSuccessAt = null, staleAfterSec = 3600, stale = false } = {}) {
            sources.set(key, {
                key, name, category, type: 'rss', terms_note: 'test terms', license_note: null,
                health: { status, stale, last_success_at: lastSuccessAt, stale_after_sec: staleAfterSec },
            });
        },
        /** Add or revise an item; returns it. */
        putItem(input) {
            const existing = items.find((i) => i.id === input.id);
            const base = existing || { id: input.id || `itm_${ids.ulid()}`, revision: 0 };
            const item = {
                id: base.id, source_key: input.source_key || 'sec-xbrl-filings', category: input.category || 'trade', kind: input.kind || 'article',
                identity: input.identity || input.canonical_url || base.id, canonical_url: input.canonical_url || null,
                title: input.title == null ? null : input.title, summary: input.summary == null ? null : input.summary, authors: [],
                published_at: input.published_at || null, source_updated_at: input.source_updated_at || null, fields: input.fields || {},
                revision: existing && input.sameRevision ? existing.revision : base.revision + 1,
                provenance: {
                    retrieved_at: input.retrieved_at, first_seen_at: existing ? existing.provenance.first_seen_at : input.retrieved_at,
                    content_hash: hash(JSON.stringify(input)), raw_body_hash: null, parser_version: 'feed@1', fetch_run_id: null,
                    license_note: null, terms_note: 'test terms', entered_by: null,
                },
                removed: input.removed || null,
                change_seq: ++seq,
            };
            if (existing) items.splice(items.indexOf(existing), 1, item); else items.push(item);
            return item;
        },
        remove(id, { at, reason }) {
            const it = items.find((i) => i.id === id);
            it.removed = { at, reason };
            it.change_seq = ++seq;
            return it;
        },
    };
}

module.exports = { startNetwork, startSources, listen };
