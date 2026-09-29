'use strict';
/**
 * T9 J6 — Trade on the openvibe-publishing 1.1.0 chassis.
 *
 *   1. the local copies the brief lists (domain/sync.js, domain/util.js, domain/freshness.js,
 *      events/webhook.js, clients/sources.js) are no longer required by any source or test file: the
 *      Sources client, the change cursor/pull loop, the signed event consumer, the normalisers, the
 *      freshness verdict and the publication glue now come from openvibe-publishing/ingest and
 *      /publication. (`rm` is denied in this harness, so the files are kept on disk but unused.)
 *   2. a dry-run ingest from a captured Sources fixture produces the same domain rows as the golden
 *      captured from the pre-conversion code.
 *   3. the Search document the publication glue emits validates against search.index-document@1 and
 *      is public and indexable.
 *   4. the outbox row and the state change share one transaction: rolled back together, committed
 *      together.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const contracts = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');

const ROOT = path.join(__dirname, '..');
const REPLACED = ['server/domain/sync.js', 'server/domain/util.js', 'server/domain/freshness.js', 'server/events/webhook.js', 'server/clients/sources.js'];
const WORDS = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
const isoOf = (v) => (v == null ? null : new Date(Number(v)).toISOString());

/** The golden captured from the pre-conversion code (id fields normalised away). */
const GOLDEN = {
    run: { ok: true, counts: { documents_created: 1, observations_created: 1, skipped_no_observation_time: 1 } },
    state: { enabled: true, cursor: 3, counts: { documents_created: 1, observations_created: 1, skipped_no_observation_time: 1 } },
    docs: [{
        kind: 'filing', form_type: '10-Q', title: 'APPLE INC (0000320193) (Filer)', filer_name: 'APPLE INC',
        cik: '0000320193', accession: '0000320193-26-000105',
        published_at: '2026-09-22T11:30:00.000Z', retrieved_at: '2026-09-22T11:55:00.000Z', removed_reason: null,
    }],
    obs: [{
        metric: 'price.close', value: '231.40', unit: 'USD', currency: 'USD',
        observed_at: '2026-09-21T20:00:00.000Z', retrieved_at: '2026-09-22T11:55:00.000Z', source_key: 'test-quotes',
    }],
};

function jsFiles(dir) {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === 'data') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...jsFiles(p));
        else if (e.name.endsWith('.js')) out.push(p);
    }
    return out;
}

(async () => {
    await check('the replaced local copies are unrequired; the chassis is used instead', async () => {
        const gone = new Set(REPLACED.map((p) => path.join(ROOT, p)));
        const requirers = [];
        for (const f of jsFiles(path.join(ROOT, 'server')).concat(jsFiles(path.join(ROOT, 'test')))) {
            if (gone.has(f)) continue;
            const src = fs.readFileSync(f, 'utf8');
            for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
                if (!m[1].startsWith('.')) continue;
                const target = path.resolve(path.dirname(f), m[1]);
                if (gone.has(target) || gone.has(`${target}.js`)) requirers.push(`${path.relative(ROOT, f)} → ${m[1]}`);
            }
        }
        assert.deepStrictEqual(requirers, [], `still required: ${requirers.join(', ')}`);
        // The chassis entry points are what the app requires now.
        const app = fs.readFileSync(path.join(ROOT, 'server', 'app.js'), 'utf8');
        assert.ok(app.includes("require('openvibe-publishing/ingest')"), 'the Sources client comes from the chassis');
        assert.ok(app.includes("require('./domain/ingest')"), 'the ingest composition');
        assert.ok(app.includes("require('./events/consumer')"), 'the signed event consumer route');
    });

    await check('a dry-run ingest from the captured Sources fixture reproduces the golden domain rows', async () => {
        const t = await boot();
        const ret = t.iso(t.T0 - 5 * 60e3);
        await t.instrument({ symbol: 'AAPL', name: 'Apple Inc.', cik: '320193', exchange: 'NASDAQ' });
        t.sources.setSource('sec-xbrl-filings', { name: 'SEC EDGAR: latest XBRL filings', lastSuccessAt: ret, staleAfterSec: 2700 });
        t.sources.putItem({
            canonical_url: 'https://www.sec.gov/Archives/edgar/data/320193/000032019326000105/0000320193-26-000105-index.htm',
            title: 'APPLE INC (0000320193) (Filer)', summary: '10-Q', published_at: '2026-09-22T11:30:00.000Z', retrieved_at: ret,
        });
        t.sources.putItem({
            source_key: 'test-quotes', kind: 'observation', canonical_url: 'https://quotes.example/aapl', title: 'AAPL close',
            retrieved_at: ret, fields: { symbol: 'AAPL', metric: 'price.close', value: '231.40', unit: 'USD', currency: 'USD', observed_at: '2026-09-21T20:00:00Z' },
        });
        t.sources.putItem({
            source_key: 'test-quotes', kind: 'observation', canonical_url: 'https://quotes.example/aapl2', title: 'AAPL open (no time)',
            retrieved_at: ret, fields: { symbol: 'AAPL', metric: 'price.open', value: '229.00', unit: 'USD', currency: 'USD' },
        });
        const r = await t.ctx.sync.run();
        const state = await t.ctx.sync.state();
        const docs = (await t.ctx.store.db.prepare(
            'SELECT kind, form_type, title, filer_name, cik, accession, published_at, retrieved_at, removed_reason FROM trade_source_documents ORDER BY source_item_id').all())
            .map((d) => ({ ...d, published_at: isoOf(d.published_at), retrieved_at: isoOf(d.retrieved_at) }));
        const obs = (await t.ctx.store.db.prepare(
            'SELECT metric, value, unit, currency, observed_at, retrieved_at, source_key FROM trade_market_observations ORDER BY metric').all())
            .map((o) => ({ ...o, observed_at: isoOf(o.observed_at), retrieved_at: isoOf(o.retrieved_at) }));
        assert.deepStrictEqual({ run: { ok: r.ok, counts: r.counts }, state: { enabled: state.enabled, cursor: state.cursor, counts: state.counts }, docs, obs }, GOLDEN);
        await t.close();
    });

    await check('the emitted Search document validates against search.index-document@1 (public, indexable)', async () => {
        const t = await boot();
        const inst = await t.instrument({ symbol: 'CHS', name: 'Chassis Corp' });
        const rev = await t.ctx.context.propose({ kind: 'user', subject: t.editor.subject, editor: true }, inst, { body: WORDS(80) });
        await t.ctx.context.publish(inst, rev.revision.number);
        const upserted = await t.events('trade.index_document.upserted');
        assert.strictEqual(upserted.length, 1, 'exactly one upserted document');
        const doc = upserted[0].payload;
        const v = contracts.validate('search.index-document@1', doc);
        assert.ok(v.valid, JSON.stringify(v.errors));
        assert.strictEqual(doc.owner, 'trade');
        assert.strictEqual(doc.type, 'instrument');
        assert.strictEqual(doc.visibility, 'public');
        assert.strictEqual(doc.indexability.decision, 'index');
        assert.strictEqual(doc.canonical_url, 'https://openvibe.trade/i/CHS');
        assert.ok(Array.isArray(doc.provenance), 'provenance is a list of references');
        await t.close();
    });

    await check('the outbox row and the state change share one transaction', async () => {
        const t = await boot();
        const { db } = t.ctx.store;
        const inst = await t.instrument({ symbol: 'TXN', name: 'Txn Corp' });
        const rev = await t.ctx.context.propose({ kind: 'user', subject: t.editor.subject, editor: true }, inst, { body: WORDS(80) });
        await t.ctx.context.publish(inst, rev.revision.number);
        const before = (await t.events('trade.index_document.upserted')).length;

        await assert.rejects(t.ctx.store.tx(async () => {
            await db.prepare("UPDATE trade_instruments SET name = 'Txn Changed' WHERE id = ?").run(inst.id);
            await t.ctx.indexing.refresh(await t.ctx.instruments.get(inst.id));
            throw new Error('boom');
        }));
        assert.strictEqual((await db.prepare('SELECT name FROM trade_instruments WHERE id = ?').get(inst.id)).name, 'Txn Corp', 'the state change rolled back');
        assert.strictEqual((await t.events('trade.index_document.upserted')).length, before, 'the outbox row did not survive the rollback');

        await t.ctx.store.tx(async () => {
            await db.prepare("UPDATE trade_instruments SET name = 'Txn Changed' WHERE id = ?").run(inst.id);
            await t.ctx.indexing.refresh(await t.ctx.instruments.get(inst.id));
        });
        assert.strictEqual((await db.prepare('SELECT name FROM trade_instruments WHERE id = ?').get(inst.id)).name, 'Txn Changed');
        assert.strictEqual((await t.events('trade.index_document.upserted')).length, before + 1, 'committed together');
        await t.close();
    });

    done();
})().catch((err) => { console.error(err); process.exit(1); });
