'use strict';
/**
 * SEC's ticker list (Sources: sec-company-tickers, kind 'instrument', fields { ticker, name, cik, exchange }) becomes
 * Trade's companies, so the SEC filings feed has something to land on:
 *   - one instrument per CIK, its first ticker the symbol, another share class a ticker alias;
 *   - SEC's later name or exchange updates an instrument the sync created, never an editor's;
 *   - an editor's equity with no CIK gets SEC's CIK; a currency code holding the ticker keeps it;
 *   - a filing for the company then becomes its document; a replay changes nothing;
 *   - the freshness tick, the sitemap and the editor's list skip the thousands of companies with no context.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const ret = t.iso(t.T0 - 5 * 60e3);
    const db = t.ctx.store.db;
    t.sources.setSource('sec-company-tickers', { name: 'SEC EDGAR: company tickers and exchanges', lastSuccessAt: ret, staleAfterSec: 259200 });
    t.sources.setSource('sec-xbrl-filings', { name: 'SEC EDGAR: latest XBRL filings', lastSuccessAt: ret, staleAfterSec: 86400 });
    const company = (ticker, name, cik, exchange) => t.sources.putItem({
        source_key: 'sec-company-tickers', kind: 'instrument', identity: ticker, canonical_url: null, title: name, summary: null,
        published_at: null, retrieved_at: ret, fields: { ticker, name, cik, exchange },
    });
    const editorMsft = await t.instrument({ symbol: 'MSFT', name: 'Microsoft (by an editor)', kind: 'equity' });

    company('GOOGL', 'Alphabet Inc.', 1652044, 'Nasdaq');
    company('GOOG', 'Alphabet Inc.', 1652044, 'Nasdaq');
    company('BRK-B', 'BERKSHIRE HATHAWAY INC', 1067983, 'NYSE');
    company('MSFT', 'MICROSOFT CORP', 789019, 'Nasdaq');
    company('SHLL', 'Shell Co', 1999999, null);
    company('USD', 'Some Fund Trust', 1888888, 'NYSE');   // the ticker is a currency code Trade already tracks
    company('NOPE', 'No Cik Corp', null, 'OTC');
    // A currency instrument named by a rate, as the ECB/Frankfurter sync creates it.
    await t.ctx.instruments.create({ symbol: 'USD', name: 'US Dollar', kind: 'currency' }, null);

    await check('a run registers one instrument per company, share classes as ticker aliases', async () => {
        const r = await t.ctx.sync.run();
        assert.strictEqual(r.ok, true, JSON.stringify(r));
        assert.strictEqual(r.counts.instruments_created, 3, JSON.stringify(r.counts));   // GOOGL, BRK-B, SHLL
        assert.strictEqual(r.counts.instruments_ticker_added, 1, 'GOOG on GOOGL');
        assert.strictEqual(r.counts.instruments_updated, 1, 'the editor\'s MSFT gets its CIK');
        assert.strictEqual(r.counts.skipped_symbol_taken, 1, 'USD stays the currency');
        assert.strictEqual(r.counts.skipped_incomplete_instrument, 1, 'no CIK, no instrument');
        const googl = await t.ctx.instruments.bySymbol('GOOGL');
        assert.deepStrictEqual({ name: googl.name, kind: googl.kind, exchange: googl.exchange, cik: googl.cik, currency: googl.currency, by: googl.created_by },
            { name: 'Alphabet Inc.', kind: 'equity', exchange: 'Nasdaq', cik: '0001652044', currency: 'USD', by: 'svc:trade' });
        const goog = await t.ctx.instruments.resolve('GOOG');
        assert.strictEqual(goog.status, 'resolved');
        assert.strictEqual(goog.instrument.id, googl.id, 'GOOG resolves to Alphabet');
        assert.strictEqual((await t.ctx.instruments.bySymbol('SHLL')).exchange, null);
        const msft = await t.ctx.instruments.get(editorMsft.id);
        assert.strictEqual(msft.cik, '0000789019');
        assert.strictEqual(msft.name, 'Microsoft (by an editor)', 'an editor\'s name is never replaced');
        assert.strictEqual((await t.ctx.instruments.bySymbol('USD')).kind, 'currency');
    });

    await check('SEC renaming a company updates the instrument the sync created; a replay changes nothing', async () => {
        company('BRK-B', 'Berkshire Hathaway Inc.', 1067983, 'NYSE');
        const r = await t.ctx.sync.run();
        assert.strictEqual(r.counts.instruments_updated, 1, JSON.stringify(r.counts));
        assert.strictEqual((await t.ctx.instruments.bySymbol('BRK-B')).name, 'Berkshire Hathaway Inc.');
        const n = (await db.prepare('SELECT COUNT(*) AS n FROM trade_instruments').get()).n;
        await db.prepare("UPDATE trade_ingest_cursor SET cursor = 0 WHERE name = 'sources.trade'").run();
        const again = await t.ctx.sync.run();
        assert.strictEqual(again.counts.instruments_created, undefined, JSON.stringify(again.counts));
        assert.strictEqual((await db.prepare('SELECT COUNT(*) AS n FROM trade_instruments').get()).n, n);
    });

    await check('a filing for a registered company becomes its document', async () => {
        t.sources.putItem({
            source_key: 'sec-xbrl-filings', kind: 'article',
            canonical_url: 'https://www.sec.gov/Archives/edgar/data/1652044/000165204426000090/0001652044-26-000090-index.htm',
            identity: 'https://www.sec.gov/Archives/edgar/data/1652044/000165204426000090/0001652044-26-000090-xbrl.zip',
            title: 'Alphabet Inc. (0001652044) (Filer)', summary: '10-Q', published_at: '2026-10-14T20:05:00.000Z', retrieved_at: ret,
            fields: { categories: [], enclosure: null, comments_url: null },
        });
        const r = await t.ctx.sync.run();
        assert.strictEqual(r.counts.documents_created, 1, JSON.stringify(r.counts));
        const googl = await t.ctx.instruments.bySymbol('GOOGL');
        const doc = await db.prepare('SELECT * FROM trade_source_documents WHERE instrument_id = ?').get(googl.id);
        assert.strictEqual(doc.form_type, '10-Q');
        const home = await t.get('/');
        assert.ok(home.text.indexOf('GOOGL') < home.text.indexOf('SHLL'), 'the company with a new filing is listed first');
    });

    await check('the freshness tick, the sitemap and the editor list leave out companies with no context', async () => {
        assert.deepStrictEqual(await t.ctx.instruments.indexCandidates(), [], 'nothing has a published context');
        const sm = await t.get('/sitemaps/instruments.xml');
        assert.strictEqual(sm.status, 200);
        assert.ok(!sm.text.includes('/i/GOOGL'), 'a company with no context is not in the sitemap');
        assert.deepStrictEqual((await t.ctx.instruments.editorAdded()).map((i) => i.symbol), ['MSFT']);
    });

    await t.close();
    done();
})();
