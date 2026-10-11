'use strict';
/**
 * The three sources OpenVibe.Sources actually holds for Trade, in the shape its adapters emit, become
 * rows:
 *   sec-xbrl-filings (rss2)        → a document for the instrument with the filing's CIK
 *   frankfurter-eur-rates (api)    → an observation of the quote currency (kind 'rate', fields
 *                                    { rate, base, date }, identity = quote)
 *   ecb-euro-reference-rates (rss1)→ an observation, the rate read from the feed's stated title
 *
 * Nothing is dropped silently: a run stores all three and reports the counters. A replay (cursor
 * reset) changes nothing.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { rewind } = require('../scripts/rewind-sync-cursor');

(async () => {
    const t = await boot();
    const ret = t.iso(t.T0 - 5 * 60e3);
    const apple = await t.instrument({ symbol: 'AAPL', name: 'Apple Inc.', cik: '320193', exchange: 'NASDAQ' });

    for (const [key, name] of [
        ['sec-xbrl-filings', 'SEC EDGAR: latest XBRL filings'],
        ['frankfurter-eur-rates', 'Frankfurter euro reference rates'],
        ['ecb-euro-reference-rates', 'ECB euro reference rates: US dollar'],
    ]) t.sources.setSource(key, { name, lastSuccessAt: ret, staleAfterSec: 86400 });

    // sec-xbrl-filings: the feed adapter keeps the index link as canonical_url and the guid as identity.
    const filing = t.sources.putItem({
        source_key: 'sec-xbrl-filings', kind: 'article',
        canonical_url: 'https://www.sec.gov/Archives/edgar/data/320193/000032019326000105/0000320193-26-000105-index.htm',
        identity: 'https://www.sec.gov/Archives/edgar/data/320193/000032019326000105/0000320193-26-000105-xbrl.zip',
        title: 'APPLE INC (0000320193) (Filer)', summary: '10-Q', published_at: '2026-09-22T11:30:00.000Z', retrieved_at: ret,
        fields: { categories: [], enclosure: { url: 'https://www.sec.gov/Archives/edgar/data/320193/000032019326000105/0000320193-26-000105-xbrl.zip', type: 'application/zip', length: 18342 }, comments_url: null },
    });
    // frankfurter-eur-rates: the api adapter maps identity=quote and extra { rate, base, date }.
    const frankfurter = t.sources.putItem({
        source_key: 'frankfurter-eur-rates', kind: 'rate', identity: 'USD',
        canonical_url: null, title: null, summary: null, published_at: null, retrieved_at: ret,
        fields: { rate: 1.0831, base: 'EUR', date: '2026-09-21' },
    });
    // ecb-euro-reference-rates: an rss1 item whose title states the rate and dc:date the observation time.
    const ecb = t.sources.putItem({
        source_key: 'ecb-euro-reference-rates', kind: 'article',
        identity: 'https://www.ecb.europa.eu/stats/exchange/eurofxref/html/eurofxref-graph-usd.en.html?date=2026-09-21&rate=1.1188',
        canonical_url: 'https://www.ecb.europa.eu/stats/exchange/eurofxref/html/eurofxref-graph-usd.en.html?date=2026-09-21&rate=1.1188',
        title: '1.1188 USD = 1 EUR 2026-09-21 ECB Reference rate',
        summary: '1 EUR buys 1.1188 US dollar (USD) - The reference exchange rates are published shortly after the concertation procedure has been completed.',
        published_at: '2026-09-21T14:15:00+01:00', retrieved_at: ret,
        fields: { categories: ['EUR'], enclosure: null, comments_url: null },
    });

    await check('a run stores the filing, both rates and the currency they name; nothing is skipped', async () => {
        const r = await t.ctx.sync.run();
        assert.strictEqual(r.ok, true, JSON.stringify(r));
        assert.strictEqual(r.counts.documents_created, 1, 'the filing');
        assert.strictEqual(r.counts.observations_created, 2, 'frankfurter and ECB');
        assert.ok(!Object.keys(r.counts).some((k) => k.startsWith('skipped_')), `no skips: ${JSON.stringify(r.counts)}`);

        const doc = await t.ctx.store.db.prepare('SELECT * FROM trade_source_documents WHERE source_item_id = ?').get(filing.id);
        assert.strictEqual(doc.instrument_id, apple.id);
        assert.strictEqual(doc.kind, 'filing');
        assert.strictEqual(doc.form_type, '10-Q');
        assert.strictEqual(doc.cik, '0000320193');
        assert.strictEqual(doc.accession, '0000320193-26-000105');

        const usd = await t.ctx.instruments.bySymbol('USD');
        assert.ok(usd, 'the quote currency the rates name is registered');
        assert.strictEqual(usd.name, 'US Dollar', 'named by its ISO 4217 English name');
        assert.strictEqual(usd.kind, 'currency');

        const obs = (await t.ctx.store.db.prepare('SELECT * FROM trade_market_observations ORDER BY source_key').all())
            .map((o) => ({ source_key: o.source_key, metric: o.metric, value: o.value, unit: o.unit, currency: o.currency, observed_at: t.iso(o.observed_at), item: o.source_item_id, instrument: o.instrument_id }));
        assert.deepStrictEqual(obs, [
            { source_key: 'ecb-euro-reference-rates', metric: 'rate', value: '1.1188', unit: 'USD', currency: 'USD', observed_at: '2026-09-21T13:15:00.000Z', item: ecb.id, instrument: usd.id },
            { source_key: 'frankfurter-eur-rates', metric: 'rate', value: '1.0831', unit: 'USD', currency: 'USD', observed_at: '2026-09-21T00:00:00.000Z', item: frankfurter.id, instrument: usd.id },
        ]);

        const n = (await t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM trade_instrument_aliases').get()).n;
        assert.ok(n >= 5, `AAPL ticker/cik/name and USD ticker/name are aliases: ${n}`);
    });

    await check('the instrument page shows the latest rate of the series, with its time and source', async () => {
        // Both rates are the same (metric, unit, currency) series, so the page shows the newer one;
        // both rows stay in the table (asserted above).
        const json = (await t.get('/i/USD.json')).json();
        assert.strictEqual(json.observations.length, 1);
        assert.deepStrictEqual([json.observations[0].value, json.observations[0].unit, json.observations[0].observed_at, json.observations[0].source.key],
            ['1.1188', 'USD', '2026-09-21T13:15:00.000Z', 'ecb-euro-reference-rates']);
    });

    await check('replaying the same Sources pages (cursor reset) creates nothing new', async () => {
        const docs = (await t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM trade_source_documents').get()).n;
        const obs = (await t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM trade_market_observations').get()).n;
        const instruments = (await t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM trade_instruments').get()).n;
        const events = (await t.events()).length;
        await t.ctx.store.db.prepare("UPDATE trade_ingest_cursor SET cursor = 0 WHERE name = 'sources.trade'").run();
        const r = await t.ctx.sync.run();
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.counts.observations_created, undefined, 'no new observations');
        assert.strictEqual((await t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM trade_source_documents').get()).n, docs);
        assert.strictEqual((await t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM trade_market_observations').get()).n, obs);
        assert.strictEqual((await t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM trade_instruments').get()).n, instruments, 'no duplicate currency instrument');
        assert.strictEqual((await t.events()).length, events, 'no new events');
    });

    await check('the rewind script is a dry run unless --apply, and re-running it is a no-op', async () => {
        const cursor = async () => (await t.ctx.store.db.prepare("SELECT cursor FROM trade_ingest_cursor WHERE name = 'sources.trade'").get()).cursor;
        const quiet = { log() {}, warn() {} };
        await t.ctx.store.db.prepare("UPDATE trade_ingest_cursor SET cursor = 1241 WHERE name = 'sources.trade'").run();
        const before = await cursor();
        assert.strictEqual(before, 1241);
        const dry = await rewind(t.ctx.store, { to: 0, apply: false, log: quiet });
        assert.strictEqual(dry.changed, false);
        assert.strictEqual(dry.dryRun, true);
        assert.strictEqual(await cursor(), before, 'dry run changes nothing');
        const applied = await rewind(t.ctx.store, { to: 0, apply: true, log: quiet });
        assert.strictEqual(applied.changed, true);
        assert.strictEqual(await cursor(), 0);
        const again = await rewind(t.ctx.store, { to: 0, apply: true, log: quiet });
        assert.strictEqual(again.changed, false, 'already at the target');
        assert.strictEqual(await cursor(), 0);
    });

    await t.close();
    done();
})();
