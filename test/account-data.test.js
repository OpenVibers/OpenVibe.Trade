'use strict';
/**
 * ADR-033: Trade's part of an account export and of an account deletion, through the signed /internal/events route
 * with a stand-in Network. Alice has a watchlist, an alert rule that fired, a draft, a context revision she wrote, an
 * observation she recorded by hand and a review she approved; Bob has a watchlist of his own. The export carries only
 * hers; the deletion removes what is hers alone, leaves her contributions without her id, keeps her review, and
 * confirms once.
 */
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/boot');
const { createNetworkSender } = require('openvibe-sdk/account-data');
const { signDeliveryHeaders } = require('openvibe-sdk/events');

const MIN = 60e3;
const EXP = 'exp_01JZ0000000000000000000EXP';
const DEL = 'del_01JZ0000000000000000000DEX';

async function startNetworkStub() {
    const calls = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (req.url === '/oauth/token') return json(200, { access_token: 'tok_trade', token_type: 'Bearer', expires_in: 300 });
            calls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString() || 'null') });
            return json(201, {});
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

const envelope = (id, type, payload) => ({ event: { event_id: id, event_type: type, source: 'network', version: 1, timestamp: new Date().toISOString(), actor: { type: 'service', id: 'network' }, subject: { type: 'account', id: payload.subject }, visibility: 'internal', payload }, seq: 1 });

(async () => {
    const stub = await startNetworkStub();
    const t = await boot({ accountSend: createNetworkSender({ networkInternalUrl: stub.url, clientId: 'trade', clientSecret: 'shh' }) });
    const { alice, bob } = t;
    const db = t.ctx.store.db;
    const count = async (sql, args) => Number(await db.value(sql, args));
    const post = (body, secret = 'hook-secret') => t.get('/internal/events', { body, headers: { 'content-type': 'application/json', ...signDeliveryHeaders(body, secret) } });
    const acme = await t.instrument({ symbol: 'ACME', name: 'Acme Corp', cik: '1234567' });

    try {
        await check('alice\'s rows are made through the app', async () => {
            for (const who of [alice, bob]) {
                const wl = await t.get('/api/v1/watchlists', { as: who, json: { name: `${who.username || 'list'} picks` } });
                assert.strictEqual(wl.status, 201, wl.text);
                assert.strictEqual((await t.get(`/api/v1/watchlists/${wl.json().watchlist.id}/items/ACME`, { method: 'PUT', as: who, json: { note: 'watch' } })).status, 200);
            }
            t.clock.advance(-10 * MIN);
            const rule = await t.get('/api/v1/alerts', { as: alice, json: { symbol: 'ACME', kind: 'threshold', metric: 'price.close', operator: 'above', threshold: '100', unit: 'USD', currency: 'USD' } });
            assert.strictEqual(rule.status, 201, rule.text);
            t.clock.set(t.T0 + 60 * MIN);
            await t.observe(acme, { metric: 'price.close', value: '101.00', source_ref: 'o1', observed_at: t.iso(t.T0 + MIN), retrieved_at: t.iso(t.T0 + MIN) });
            assert.strictEqual(await count('SELECT count(*) FROM trade_alert_deliveries WHERE owner_subject = $1', [alice.subject]), 1, 'the rule fired');
            await t.ctx.observations.record({ source_key: 'manual', unit: 'USD', currency: 'USD', metric: 'price.close', value: '99.00', source_ref: 'hand-1', observed_at: t.iso(t.T0 + 2 * MIN), retrieved_at: t.iso(t.T0 + 2 * MIN) }, acme, { recordedBy: alice.subject });
            await t.ctx.store.revisions.create({ entityId: acme.id, expectedRevision: 0, content: 'Acme makes anvils.', fields: {}, meta: { authorship: { mode: 'human', authors: [alice.subject, bob.subject] } }, author: alice.subject, message: 'first', allowUnchanged: true });
            await t.ctx.store.revisions.create({ entityId: acme.id, expectedRevision: 1, content: 'Acme makes anvils and rockets.', fields: {}, meta: { authorship: { mode: 'human', authors: [bob.subject, alice.subject] } }, author: bob.subject, message: 'second', allowUnchanged: true });
            await db.exec(`INSERT INTO trade_context_drafts (entity_id, owner, base_revision, content, created_at, updated_at) VALUES ($1, $2, 1, 'draft text', 1, 1)`, [acme.id, alice.subject]);
            await db.exec(`INSERT INTO trade_context_reviews (entity_id, revision, reviewer, decision, reviewed_at) VALUES ($1, 1, $2, 'approved', 1)`, [acme.id, alice.subject]);
        });

        await check('an export part carries only alice\'s rows, with this service\'s token', async () => {
            const r = await post(JSON.stringify(envelope('evt_01JZ0000000000000000000E01', 'network.account.export_requested', { export_id: EXP, subject: alice.subject })));
            assert.strictEqual(r.status, 200, r.text);
            const part = stub.calls.find((c) => c.url === `/internal/account-exports/${EXP}/parts`);
            assert.strictEqual(part.auth, 'Bearer tok_trade');
            const files = Object.fromEntries(part.body.files.map((f) => [f.name, f.content]));
            assert.deepStrictEqual(Object.keys(files).sort(), ['alert-deliveries.json', 'alert-rules.json', 'context-drafts.json', 'context-reviews.json', 'context-revisions.json', 'observations.json', 'watchlist-items.json', 'watchlists.json']);
            assert.strictEqual(files['watchlists.json'].length, 1);
            assert.strictEqual(files['watchlist-items.json'].length, 1);
            assert.deepStrictEqual(files['observations.json'].map((o) => o.value), ['99.00'], 'only what she recorded by hand');
            assert.ok(!JSON.stringify(part.body).includes(bob.subject), 'nobody else\'s id');
        });

        await check('a deletion removes what is hers, leaves her contributions without her id, keeps her review, and confirms once', async () => {
            const body = JSON.stringify(envelope('evt_01JZ0000000000000000000D01', 'network.account.deleted', { deletion_id: DEL, subject: alice.subject }));
            assert.strictEqual((await post(body)).status, 200);
            const a = [alice.subject];
            assert.strictEqual(await count('SELECT count(*) FROM trade_watchlists WHERE owner_subject = $1', a), 0);
            assert.strictEqual(await count('SELECT count(*) FROM trade_watchlists WHERE owner_subject = $1', [bob.subject]), 1, 'bob\'s list stays');
            assert.strictEqual(await count('SELECT count(*) FROM trade_watchlist_items'), 1, 'her items went with her list');
            assert.strictEqual(await count('SELECT count(*) FROM trade_alert_rules WHERE owner_subject = $1', a), 0);
            assert.strictEqual(await count('SELECT count(*) FROM trade_alert_deliveries WHERE owner_subject = $1', a), 0);
            assert.strictEqual(await count('SELECT count(*) FROM trade_context_drafts WHERE owner = $1', a), 0);
            assert.strictEqual(await count('SELECT count(*) FROM trade_context_revisions WHERE author IS NULL'), 1, 'her revision stays, authorless');
            const revs = await db.many('SELECT number, author, meta, content FROM trade_context_revisions WHERE entity_id = $1 ORDER BY number', [acme.id]);
            const authorsOf = (r) => (typeof r.meta === 'string' ? JSON.parse(r.meta) : r.meta).authorship.authors;
            assert.deepStrictEqual(revs.map((r) => [r.number, r.author, authorsOf(r)]), [[1, null, [bob.subject]], [2, bob.subject, [bob.subject]]], 'her id leaves both, bob\'s stays');
            assert.deepStrictEqual(revs.map((r) => r.content), ['Acme makes anvils.', 'Acme makes anvils and rockets.'], 'the text never changes');
            assert.strictEqual(await count("SELECT count(*) FROM trade_market_observations WHERE recorded_by = 'deleted'"), 1);
            assert.strictEqual(await count('SELECT count(*) FROM trade_market_observations WHERE recorded_by = $1', a), 0);
            assert.strictEqual(await count('SELECT count(*) FROM trade_context_reviews WHERE reviewer = $1', a), 1, 'her approval stays');
            const conf = stub.calls.filter((c) => c.url === `/internal/account-deletions/${DEL}/confirmations`);
            assert.strictEqual(conf.length, 1);
            assert.deepStrictEqual([conf[0].body.erased.trade_watchlists, conf[0].body.erased.trade_alert_rules, conf[0].body.erased.trade_alert_deliveries], [1, 1, 1]);
            assert.strictEqual(conf[0].body.retained.trade_context_reviews, 1);
            const again = await post(body);
            assert.strictEqual(again.json().duplicate, true);
            assert.strictEqual(stub.calls.filter((c) => c.url.includes('/confirmations')).length, 1, 'confirmed once');
        });

        await check('the rows stay append-only outside the erasure, and inside it nothing but the person\'s id may change', async () => {
            await assert.rejects(db.exec("UPDATE trade_context_revisions SET author = NULL WHERE number = 2"), /immutable/);
            await assert.rejects(db.exec("UPDATE trade_market_observations SET recorded_by = 'deleted' WHERE source_ref = 'o1'"), /immutable/);
            await assert.rejects(db.tx(async (tx) => {
                await tx.value("SELECT set_config('trade.account_erasure', 'on', true)");
                await tx.exec("UPDATE trade_context_revisions SET content = 'rewritten', author = NULL WHERE number = 2");
            }), /immutable/);
            await assert.rejects(db.tx(async (tx) => {
                await tx.value("SELECT set_config('trade.account_erasure', 'on', true)");
                await tx.exec("UPDATE trade_market_observations SET recorded_by = 'deleted', value = '1.00' WHERE source_ref = 'o1'");
            }), /immutable/);
        });

        await check('the route refuses a bad signature', async () => {
            const body = JSON.stringify(envelope('evt_01JZ0000000000000000000E02', 'network.account.export_requested', { export_id: EXP, subject: alice.subject }));
            assert.strictEqual((await post(body, 'not-the-secret')).status, 401);
        });
    } finally {
        await t.close();
        await stub.close();
    }
    done();
})();
