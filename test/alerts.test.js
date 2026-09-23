'use strict';
/**
 * Alerts are idempotent per triggering observation (and per document): one delivery row and one
 * trade.alert.triggered event per (rule, trigger), whatever is replayed or retried. Threshold rules
 * fire on a crossing; late (older) observations never fire. No email: the event is for the owner.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const MIN = 60e3;

(async () => {
    const t = await boot();
    const acme = t.instrument({ symbol: 'ACME', name: 'Acme Corp', cik: '1234567' });
    const iso = t.iso;
    const obs = (value, minutes, ref) => t.observe(acme, { metric: 'price.close', value, source_ref: ref, observed_at: iso(t.T0 + minutes * MIN), retrieved_at: iso(t.T0 + minutes * MIN) });
    const deliveries = () => t.ctx.store.db.prepare('SELECT * FROM trade_alert_deliveries ORDER BY created_at, id').all();
    let ruleId;

    await check('alice creates a threshold rule through the API (for herself only)', async () => {
        t.clock.advance(-10 * MIN);
        const r = await t.get('/api/v1/alerts', { as: t.alice, json: { symbol: 'ACME', kind: 'threshold', metric: 'price.close', operator: 'above', threshold: '100', unit: 'USD', currency: 'USD' } });
        assert.strictEqual(r.status, 201, r.text);
        ruleId = r.json().rule.id;
        t.clock.set(t.T0 + 60 * MIN);
    });

    await check('an observation crossing the threshold delivers exactly once, with one event', async () => {
        obs('99.50', 1, 'o1');
        assert.strictEqual(deliveries().length, 0, 'below: nothing');
        const { observation } = obs('101.00', 2, 'o2');
        const d = deliveries();
        assert.strictEqual(d.length, 1);
        assert.strictEqual(d[0].trigger_kind, 'observation');
        assert.strictEqual(d[0].trigger_id, observation.id);
        const ev = t.events('trade.alert.triggered');
        assert.strictEqual(ev.length, 1);
        assert.strictEqual(ev[0].visibility, 'subject');
        assert.deepStrictEqual(ev[0].subject, { type: 'user', id: t.alice.subject });
        assert.strictEqual(ev[0].payload.trigger.value, '101.00');
        assert.strictEqual(ev[0].payload.trigger.observed_at, iso(t.T0 + 2 * MIN));
        assert.ok(ev[0].payload.disclaimer.includes('not investment advice'));
        assert.strictEqual(d[0].event_id, ev[0].event_id);
    });

    await check('replaying the same observation (same source reference) delivers nothing new', async () => {
        const r = obs('101.00', 2, 'o2');
        assert.strictEqual(r.created, false);
        const api = await t.get('/api/v1/observations', { as: t.network.serviceToken('feed', ['trade.observation.write']), json: { symbol: 'ACME', metric: 'price.close', value: '101.00', unit: 'USD', currency: 'USD', source_key: 'test-feed', source_ref: 'o2', observed_at: iso(t.T0 + 2 * MIN), retrieved_at: iso(t.T0 + 2 * MIN) } });
        assert.strictEqual(api.status, 200);
        assert.strictEqual(deliveries().length, 1);
        assert.strictEqual(t.events('trade.alert.triggered').length, 1);
    });

    await check('re-running evaluation for the same observation cannot deliver twice (UNIQUE rule × trigger)', async () => {
        const o = t.ctx.store.db.prepare("SELECT * FROM trade_market_observations WHERE source_ref = 'o2'").get();
        t.ctx.store.db.prepare('UPDATE trade_alert_rules SET armed = 1, last_observed_at = NULL WHERE id = ?').run(ruleId);
        t.ctx.store.tx(() => t.ctx.alerts.onObservation(o, acme));
        t.ctx.store.tx(() => t.ctx.alerts.onObservation(o, acme));
        assert.strictEqual(deliveries().length, 1);
        assert.strictEqual(t.events('trade.alert.triggered').length, 1);
    });

    await check('staying above does not repeat; dropping below re-arms; crossing again delivers once more', async () => {
        obs('102.00', 3, 'o3');
        assert.strictEqual(deliveries().length, 1, 'still above: no repeat');
        obs('98.00', 4, 'o4');
        assert.strictEqual(deliveries().length, 1);
        obs('100.50', 5, 'o5');
        assert.strictEqual(deliveries().length, 2);
        assert.strictEqual(t.events('trade.alert.triggered').length, 2);
    });

    await check('a late observation (older than the last one evaluated) never fires', async () => {
        obs('97.00', 6, 'o6');   // re-arms
        obs('150.00', 1.5, 'late');
        assert.strictEqual(deliveries().length, 2);
    });

    await check('unit or currency mismatch never fires (no conversion)', async () => {
        t.observe(acme, { metric: 'price.close', value: '500', unit: 'EUR', currency: 'EUR', source_ref: 'eur', observed_at: iso(t.T0 + 7 * MIN), retrieved_at: iso(t.T0 + 7 * MIN) });
        assert.strictEqual(deliveries().length, 2);
    });

    await check('document rules: new_document and filing_type fire once per document; revisions of the item never re-fire', async () => {
        const nd = await t.get('/api/v1/alerts', { as: t.bob, json: { symbol: 'ACME', kind: 'new_document' } });
        assert.strictEqual(nd.status, 201);
        const ft = await t.get('/api/v1/alerts', { as: t.bob, json: { symbol: 'ACME', kind: 'filing_type', form_types: ['8-K'] } });
        assert.strictEqual(ft.status, 201);
        const url = 'https://www.sec.gov/Archives/edgar/data/1234567/000123456726000001/0001234567-26-000001-index.htm';
        const item = t.sources.putItem({ canonical_url: url, title: 'ACME CORP', summary: '10-Q', published_at: iso(t.T0), retrieved_at: iso(t.clock.now()) });
        await t.ctx.sync.run();
        const bobs = () => deliveries().filter((d) => d.owner_subject === t.bob.subject);
        assert.strictEqual(bobs().length, 1, 'new_document fired, filing_type(8-K) did not for a 10-Q');
        t.sources.putItem({ id: item.id, canonical_url: url, title: 'ACME CORP (amended title)', summary: '10-Q', published_at: iso(t.T0), retrieved_at: iso(t.clock.now()) });
        await t.ctx.sync.run();
        t.ctx.store.db.prepare("UPDATE trade_sync_state SET cursor = 0 WHERE name = 'sources.trade'").run();
        await t.ctx.sync.run();
        assert.strictEqual(bobs().length, 1, 'item revision and page replay: no second delivery');
        assert.strictEqual((await t.get('/i/ACME.json')).json().documents[0].title, 'ACME CORP (amended title)');
        t.sources.putItem({ canonical_url: 'https://www.sec.gov/Archives/edgar/data/1234567/000123456726000002/0001234567-26-000002-index.htm', title: 'ACME CORP', summary: '8-K', published_at: iso(t.T0), retrieved_at: iso(t.clock.now()) });
        await t.ctx.sync.run();
        assert.strictEqual(bobs().length, 3, 'an 8-K: new_document + filing_type');
    });

    await check('rules and deliveries are private: someone else sees none and cannot delete them', async () => {
        const mine = (await t.get('/api/v1/alerts', { as: t.alice })).json().rules;
        assert.strictEqual(mine.length, 1);
        const bobsView = (await t.get('/api/v1/alerts', { as: t.bob })).json().rules;
        assert.ok(bobsView.every((r) => r.id !== ruleId));
        assert.strictEqual((await t.get(`/api/v1/alerts/${ruleId}`, { as: t.bob, method: 'DELETE' })).status, 404);
        const dl = (await t.get('/api/v1/alerts/deliveries', { as: t.alice })).json().deliveries;
        assert.strictEqual(dl.length, 2);
        assert.ok(dl.every((d) => d.trigger.observed_at && d.trigger.source_key));
        assert.strictEqual((await t.get(`/api/v1/alerts/${ruleId}`, { as: t.alice, method: 'DELETE' })).status, 200);
    });

    await check('a service acting for a person needs the capability and X-OV-Subject', async () => {
        const svc = t.network.serviceToken('notifications', ['trade.alert.read']);
        assert.strictEqual((await t.get('/api/v1/alerts', { as: svc })).status, 400);
        const r = await t.get('/api/v1/alerts', { as: svc, headers: { 'x-ov-subject': t.bob.subject } });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.json().rules.length, 2);
        assert.strictEqual((await t.get('/api/v1/alerts', { as: svc, method: 'POST', json: { symbol: 'ACME', kind: 'new_document' }, headers: { 'x-ov-subject': t.bob.subject } })).status, 403);
    });

    await check('no email is ever sent: Trade has no mail client and no mail configuration', async () => {
        const fs = require('fs');
        const path = require('path');
        const files = [];
        (function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } })(path.join(__dirname, '..', 'server'));
        const src = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
        assert.ok(!/nodemailer|smtp|sendmail|SMTP_/i.test(src));
    });

    await t.close();
    done();
})();
