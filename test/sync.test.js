'use strict';
/**
 * OpenVibe.Sources → Trade: SEC EDGAR filings become documents of the instrument with that CIK;
 * observation items become observations only with their own observation time; unmatched items are
 * skipped and counted; removals hide documents; replaying pages changes nothing; the signed webhook
 * wakes the sync and is idempotent per event id. Deterministic resolution.
 */
const assert = require('assert');
const { signDelivery, signDeliveryHeaders } = require('openvibe-sdk/events');
const { boot, check, done } = require('./helpers/boot');
const { mapItem } = require('../server/domain/mapping');

(async () => {
    const t = await boot();
    const apple = t.instrument({ symbol: 'AAPL', name: 'Apple Inc.', cik: '320193', exchange: 'NASDAQ' });
    t.instrument({ symbol: 'ACME', name: 'Acme Corp' });
    t.instrument({ symbol: 'ACMX', name: 'ACME CORPORATION' });   // normalises to the same name as ACME Corp
    const ret = t.iso(t.T0 - 5 * 60e3);
    t.sources.setSource('sec-xbrl-filings', { name: 'SEC EDGAR: latest XBRL filings', lastSuccessAt: ret, staleAfterSec: 2700 });

    const filing = t.sources.putItem({
        canonical_url: 'https://www.sec.gov/Archives/edgar/data/320193/000032019326000105/0000320193-26-000105-index.htm',
        title: 'APPLE INC (0000320193) (Filer)', summary: '10-Q', published_at: '2026-09-22T11:30:00.000Z', retrieved_at: ret,
    });
    t.sources.putItem({ canonical_url: 'https://www.sec.gov/Archives/edgar/data/789019/000078901926000050/0000789019-26-000050-index.htm', title: 'MICROSOFT CORP', summary: '8-K', published_at: '2026-09-22T11:40:00.000Z', retrieved_at: ret });
    t.sources.putItem({ source_key: 'test-quotes', kind: 'observation', canonical_url: 'https://quotes.example/aapl', title: 'AAPL close', retrieved_at: ret, fields: { symbol: 'AAPL', metric: 'price.close', value: '231.40', unit: 'USD', currency: 'USD', observed_at: '2026-09-21T20:00:00Z' } });
    t.sources.putItem({ source_key: 'test-quotes', kind: 'observation', canonical_url: 'https://quotes.example/aapl2', title: 'AAPL open (no time)', retrieved_at: ret, fields: { symbol: 'AAPL', metric: 'price.open', value: '229.00', unit: 'USD', currency: 'USD' } });

    await check('mapping: an EDGAR index URL yields CIK, accession, form type and filer; nothing else is guessed', async () => {
        const m = mapItem(filing);
        assert.strictEqual(m.type, 'document');
        assert.strictEqual(m.document.cik, '0000320193');
        assert.strictEqual(m.document.accession, '0000320193-26-000105');
        assert.strictEqual(m.document.form_type, '10-Q');
        assert.strictEqual(m.document.filer_name, 'APPLE INC');
        const noDate = mapItem({ ...filing, id: 'itm_X', published_at: null });
        assert.strictEqual(noDate.document.published_at, null, 'no publication date stays null');
        assert.strictEqual(mapItem({ ...filing, summary: 'APPLE INC quarterly report' }).document.form_type, null, 'not a form type → null');
        assert.strictEqual(mapItem({ ...filing, provenance: { ...filing.provenance, retrieved_at: null } }).type, 'skip');
    });

    await check('a sync run records matched filings and observations, skips the rest, and advances the cursor', async () => {
        const r = await t.ctx.sync.run();
        assert.strictEqual(r.ok, true, JSON.stringify(r));
        assert.strictEqual(r.counts.documents_created, 1);
        assert.strictEqual(r.counts.observations_created, 1);
        assert.strictEqual(r.counts.skipped_no_matching_instrument, 1, 'MICROSOFT has no instrument here');
        assert.strictEqual(r.counts.skipped_no_observation_time, 1, 'an observation without its own time is not recorded');
        const json = (await t.get('/i/AAPL.json')).json();
        assert.strictEqual(json.documents.length, 1);
        const d = json.documents[0];
        assert.strictEqual(d.form_type, '10-Q');
        assert.strictEqual(d.published_at, '2026-09-22T11:30:00.000Z');
        assert.strictEqual(d.retrieved_at, ret);
        assert.strictEqual(d.source.item_id, filing.id);
        assert.deepStrictEqual(json.observations.map((o) => [o.metric, o.value, o.observed_at]), [['price.close', '231.40', '2026-09-21T20:00:00.000Z']]);
        assert.strictEqual(t.ctx.sync.state().cursor, 4);
        const src = json.sources.find((s) => s.key === 'sec-xbrl-filings');
        assert.strictEqual(src.name, 'SEC EDGAR: latest XBRL filings');
        assert.strictEqual(src.stale_after_sec, 2700);
    });

    await check('replaying the same Sources pages (cursor reset) creates nothing new', async () => {
        const docs = t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM trade_source_documents').get().n;
        const obs = t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM trade_market_observations').get().n;
        const evts = t.events().length;
        t.ctx.store.db.prepare("UPDATE trade_sync_state SET cursor = 0 WHERE name = 'sources.trade'").run();
        const r = await t.ctx.sync.run();
        assert.strictEqual(r.ok, true);
        assert.strictEqual(t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM trade_source_documents').get().n, docs);
        assert.strictEqual(t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM trade_market_observations').get().n, obs);
        assert.strictEqual(t.events('trade.observation.created').length, 1);
        assert.strictEqual(t.events().length, evts, 'no new events at all');
    });

    await check('a removed Sources item hides the document (the row stays as the record)', async () => {
        t.sources.remove(filing.id, { at: t.iso(t.T0), reason: 'takedown request' });
        await t.ctx.sync.run();
        assert.strictEqual((await t.get('/i/AAPL.json')).json().documents.length, 0);
        const row = t.ctx.store.db.prepare('SELECT * FROM trade_source_documents WHERE source_item_id = ?').get(filing.id);
        assert.strictEqual(row.removed_reason, 'takedown request');
        const feed = await t.get('/i/AAPL/documents.xml');
        assert.ok(!feed.text.includes('10-Q'), 'gone from the feed too');
    });

    await check('resolution is deterministic: CIK, then ticker, then exact normalised name; several names → ambiguous', async () => {
        const r = (q, k) => t.ctx.instruments.resolve(q, k ? { kind: k } : {});
        assert.strictEqual(r('320193').instrument.symbol, 'AAPL');
        assert.strictEqual(r('CIK0000320193').match.kind, 'cik');
        assert.strictEqual(r('aapl').instrument.symbol, 'AAPL');
        assert.strictEqual(r('Apple Inc').instrument.symbol, 'AAPL');
        assert.strictEqual(r('APPLE, INC.').instrument.symbol, 'AAPL');
        const amb = r('Acme Corporation');
        assert.strictEqual(amb.status, 'ambiguous');
        assert.deepStrictEqual(amb.candidates.map((i) => i.symbol), ['ACME', 'ACMX']);
        assert.strictEqual(amb.instrument, null, 'none is chosen');
        assert.strictEqual(r('Appl').status, 'not_found', 'no prefix or fuzzy matching');
        t.ctx.instruments.addAlias(apple, 'ticker', 'APC', t.editor.subject);
        assert.strictEqual(r('APC').match.kind, 'ticker');
        for (let i = 0; i < 3; i++) assert.deepStrictEqual(r('Acme Corporation').candidates.map((x) => x.id), amb.candidates.map((x) => x.id));
        const page = await t.get('/i/APC');
        assert.strictEqual(page.status, 301);
        assert.strictEqual(page.headers.get('location'), '/i/AAPL');
        assert.strictEqual((await t.get('/i/aapl')).headers.get('location'), '/i/AAPL');
        const api = await t.get('/api/v1/instruments/resolve?q=Acme%20Corp', { as: t.network.serviceToken('ai', ['trade.instrument.resolve']) });
        assert.strictEqual(api.json().status, 'ambiguous');
        assert.strictEqual((await t.get('/api/v1/instruments/resolve?q=AAPL', { as: t.network.serviceToken('ai', ['trade.context.read']) })).status, 403);
    });

    await check('a ticker or CIK names one instrument: collisions are 409', async () => {
        const ed = t.editor;
        assert.strictEqual((await t.get('/api/v1/instruments', { as: { ...ed, role: 'user' }, json: { symbol: 'APC', name: 'Other' } })).status, 409);
        const acme = t.ctx.instruments.bySymbol('ACME');
        assert.throws(() => t.ctx.instruments.addAlias(acme, 'cik', '320193'), (e) => e.status === 409);
    });

    await check('the signed webhook wakes the sync once per event id; a bad signature, v1-only or stale v2 is 401', async () => {
        t.sources.putItem({ canonical_url: 'https://www.sec.gov/Archives/edgar/data/320193/000032019326000106/0000320193-26-000106-index.htm', title: 'APPLE INC', summary: '8-K', published_at: '2026-09-22T12:10:00.000Z', retrieved_at: t.iso(t.T0) });
        const body = JSON.stringify({ event: { event_id: 'evt_01JABCDEFGHJKMNPQRSTVWXYZ0', event_type: 'sources.item.created', payload: {} }, seq: 7 });
        const bad = await t.get('/internal/events', { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-openvibe-signature': 'sha256=00' } });
        assert.strictEqual(bad.status, 401);
        const v1only = await t.get('/internal/events', { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-openvibe-signature': signDelivery(body, 'hook-secret') } });
        assert.strictEqual(v1only.status, 401, 'v1 only: refused (requireV2)');
        const stale = await t.get('/internal/events', { method: 'POST', body, headers: { 'content-type': 'application/json', ...signDeliveryHeaders(body, 'hook-secret', { now: Date.now() - 301000 }) } });
        assert.strictEqual(stale.status, 401, 'stale v2 (outside the 300 s window): refused');
        const ok = await t.get('/internal/events', { method: 'POST', body, headers: { 'content-type': 'application/json', ...signDeliveryHeaders(body, 'hook-secret') } });
        assert.strictEqual(ok.status, 200);
        assert.strictEqual(ok.json().sync, true);
        await t.ctx.sync.run();
        assert.strictEqual((await t.get('/i/AAPL.json')).json().documents.length, 1);
        const again = await t.get('/internal/events', { method: 'POST', body, headers: { 'content-type': 'application/json', ...signDeliveryHeaders(body, 'hook-secret') } });
        assert.strictEqual(again.json().duplicate, true);
        assert.strictEqual(again.json().sync, false);
    });

    await check('Trade asks Sources with its own service token for exactly sources.item.read and sources.source.read', async () => {
        const g = t.network.grants.filter((x) => x.audience === 'openvibe.sources');
        assert.ok(g.length >= 1);
        assert.deepStrictEqual(g[0].scope.split(' ').sort(), ['sources.item.read', 'sources.source.read']);
        assert.ok(t.sources.calls.some((c) => /category=trade/.test(c.url) && /include_removed=1/.test(c.url)));
    });

    await t.close();
    done();
})();
