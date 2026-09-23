'use strict';
/**
 * The proposals the lead releases in the next openvibe-contracts version are valid against the
 * released schemas, match what the code enforces and emits, and every envelope Trade produces is a
 * valid events.event-envelope@1.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const contracts = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');
const { PROPOSED } = require('../server/auth/capabilities');

const DIR = path.join(__dirname, '..', 'docs', 'capabilities-proposal');

(async () => {
    const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'));
    const caps = files.map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'service-manifest-proposal.json'), 'utf8'));

    await check('every capability proposal is a valid capabilities.capability@1 with 3+ segments, owned by trade', async () => {
        for (const c of caps) {
            const v = contracts.validate('capabilities.capability@1', c);
            assert.ok(v.valid, `${c.id}: ${JSON.stringify(v.errors)}`);
            assert.strictEqual(c.owner, 'trade');
            assert.ok(c.id.split('.').length >= 3);
            assert.strictEqual(`${c.id}.json`, files[caps.indexOf(c)]);
            assert.ok(!contracts.capabilities.get(c.id) || contracts.capabilities.get(c.id).owner === 'trade', `${c.id} collides with a released capability`);
        }
    });

    await check('the proposals are exactly the capabilities the code enforces, and cover the charter\'s', async () => {
        assert.deepStrictEqual(caps.map((c) => c.id).sort(), [...PROPOSED].sort());
        assert.deepStrictEqual([...manifest.capabilities].sort(), [...PROPOSED].sort());
        for (const id of ['trade.watchlist.create', 'trade.watchlist.update', 'trade.instrument.resolve', 'trade.alert.create', 'trade.alert.delete', 'trade.context.read']) assert.ok(PROPOSED.has(id), id);
        const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'http', 'api.js'), 'utf8');
        for (const c of caps) for (const route of c.implementedBy) assert.ok(src.includes(`'${route.split(' ')[1].replace('/api/v1', '')}'`), `${c.id}: ${route} is not in http/api.js`);
    });

    await check('the service manifest proposal is a valid registry.service-manifest@1 and declares every event', async () => {
        const v = contracts.validate('registry.service-manifest@1', manifest);
        assert.ok(v.valid, JSON.stringify(v.errors));
        assert.strictEqual(manifest.id, 'trade');
        for (const c of caps) for (const e of c.events) assert.ok(manifest.eventsProduced.includes(e), `${c.id} names ${e}, missing from eventsProduced`);
        const src = fs.readdirSync(path.join(__dirname, '..', 'server', 'domain')).map((f) => fs.readFileSync(path.join(__dirname, '..', 'server', 'domain', f), 'utf8')).join('\n');
        for (const m of src.matchAll(/event_type: (?:[a-z.]+ \? )?'([a-z_.]+)'(?: : '([a-z_.]+)')?/g)) {
            for (const e of [m[1], m[2]].filter(Boolean)) assert.ok(manifest.eventsProduced.includes(e), e);
        }
    });

    await check('every envelope Trade actually produces validates as events.event-envelope@1 (and Search documents as search.index-document@1)', async () => {
        const t = await boot();
        const acme = t.instrument({ symbol: 'ACME', name: 'Acme Corp' });
        t.ctx.freshness.report('test-feed', { status: 'healthy', lastSuccessAt: t.T0, staleAfterSec: 60 });
        await t.get('/api/v1/alerts', { as: t.alice, json: { symbol: 'ACME', kind: 'threshold', metric: 'price.close', operator: 'above', threshold: '1', unit: 'USD' } });
        t.clock.advance(1000);
        t.observe(acme, { metric: 'price.close', value: '2', source_ref: 'x', observed_at: t.iso(t.clock.now() - 1000), retrieved_at: t.iso(t.clock.now()) });
        t.clock.advance(3600e3);
        t.ctx.freshness.evaluateAll();
        const rev = t.ctx.context.propose({ kind: 'user', subject: t.editor.subject, editor: true }, acme, { body: Array.from({ length: 80 }, () => 'word').join(' ') });
        t.ctx.context.publish(acme, rev.revision.number);
        const all = t.events();
        const types = new Set(all.map((e) => e.event_type));
        for (const ty of ['trade.observation.created', 'trade.alert.triggered', 'trade.source.stale', 'trade.index_document.upserted']) assert.ok(types.has(ty), `${ty} produced`);
        for (const e of all) {
            const v = contracts.validate('events.event-envelope@1', e);
            assert.ok(v.valid, `${e.event_type}: ${JSON.stringify(v.errors)}`);
            assert.ok(manifest.eventsProduced.includes(e.event_type), e.event_type);
            if (e.event_type === 'trade.index_document.upserted') {
                const d = contracts.validate('search.index-document@1', e.payload);
                assert.ok(d.valid, JSON.stringify(d.errors));
            }
        }
        await t.close();
    });

    done();
})();
