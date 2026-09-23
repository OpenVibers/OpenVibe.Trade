'use strict';
/**
 * Stale or unavailable feeds are shown as stale — with "stale since" — and never replaced with
 * invented values. Driven by an injected clock; transitions emit trade.source.stale|recovered once.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const HOUR = 3600e3;

(async () => {
    const t = await boot();
    const acme = t.instrument({ symbol: 'ACME', name: 'Acme Corp' });
    const iso = t.iso;

    await check('an observation from a source with a known window is current inside the window', async () => {
        t.ctx.freshness.report('test-feed', { name: 'Test feed', status: 'healthy', lastSuccessAt: t.T0, staleAfterSec: 3600 });
        t.observe(acme, { metric: 'price.close', value: '10.50', source_ref: 'a', observed_at: iso(t.T0 - 60e3), retrieved_at: iso(t.T0) });
        const json = (await t.get('/i/ACME.json')).json();
        assert.strictEqual(json.observations[0].freshness.stale, false);
        assert.strictEqual(json.sources[0].status, 'fresh');
        const page = await t.get('/i/ACME');
        assert.ok(page.text.includes('<span class="badge fresh">current</span>'));
        assert.ok(!page.text.includes('badge stale'));
    });

    await check('after the window, the same value is shown as stale since last success + window (clock advanced, nothing else changed)', async () => {
        t.clock.advance(2 * HOUR);
        const json = (await t.get('/i/ACME.json')).json();
        const o = json.observations[0];
        assert.strictEqual(o.value, '10.50', 'the value is kept, not replaced');
        assert.strictEqual(o.freshness.stale, true);
        assert.strictEqual(o.freshness.stale_since, iso(t.T0 + HOUR));
        assert.strictEqual(o.freshness.reason, 'source_stale');
        assert.strictEqual(json.sources[0].status, 'stale');
        assert.strictEqual(json.sources[0].stale_since, iso(t.T0 + HOUR));
        const page = await t.get('/i/ACME');
        assert.ok(page.text.includes('<span class="badge stale">stale</span> since <time datetime="2026-09-22T13:00:00.000Z">2026-09-22 13:00 UTC</time>'), 'explicit stale-since label');
        assert.ok(page.text.includes('<data value="10.50">10.50</data>'), 'the old value stays visible with its timestamps');
        assert.ok(/class="is-stale"/.test(page.text));
    });

    await check('the transition emits trade.source.stale exactly once, and recovery emits trade.source.recovered once', async () => {
        t.ctx.freshness.evaluateAll();
        t.ctx.freshness.evaluateAll();
        const stale = t.events('trade.source.stale');
        assert.strictEqual(stale.length, 1);
        assert.strictEqual(stale[0].payload.stale_since, iso(t.T0 + HOUR));
        t.observe(acme, { metric: 'price.close', value: '10.60', source_ref: 'b', observed_at: iso(t.clock.now() - 60e3), retrieved_at: iso(t.clock.now()) });
        t.ctx.freshness.evaluateAll();
        assert.strictEqual(t.events('trade.source.recovered').length, 1);
        assert.strictEqual(t.events('trade.source.stale').length, 1);
        const json = (await t.get('/i/ACME.json')).json();
        assert.strictEqual(json.observations[0].value, '10.60');
        assert.strictEqual(json.observations[0].freshness.stale, false);
    });

    await check('a value older than its own max_age is stale even while its source is fresh', async () => {
        t.observe(acme, { metric: 'eps.diluted', value: '1.23', unit: 'USD/share', source_ref: 'c', max_age_sec: 3600, observed_at: iso(t.clock.now() - 2 * HOUR), retrieved_at: iso(t.clock.now()) });
        const o = (await t.get('/i/ACME.json')).json().observations.find((x) => x.metric === 'eps.diluted');
        assert.strictEqual(o.freshness.stale, true);
        assert.strictEqual(o.freshness.reason, 'value_older_than_max_age');
        assert.strictEqual(o.freshness.stale_since, iso(t.clock.now() - HOUR));
    });

    await check('a source Trade has never heard from is "freshness unknown", never "current"', async () => {
        const v = t.ctx.freshness.view('nobody-knows');
        assert.strictEqual(v.status, 'unknown');
        assert.strictEqual(v.stale, true);
    });

    await check('Sources unavailable: the sync records the failure and invents nothing; data decays to stale on Trade\'s clock', async () => {
        const before = t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM trade_market_observations').get().n;
        t.sources.setDown(true);
        const r = await t.ctx.sync.run();
        assert.strictEqual(r.ok, false);
        const state = t.ctx.sync.state();
        assert.ok(state.last_error && /503/.test(state.last_error));
        assert.strictEqual(t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM trade_market_observations').get().n, before);
        t.clock.advance(5 * HOUR);
        const json = (await t.get('/i/ACME.json')).json();
        assert.ok(json.observations.every((o) => o.freshness.stale), 'everything is stale now');
        assert.ok(json.observations.find((o) => o.metric === 'price.close').value === '10.60', 'last real value kept, labelled stale');
        const sourcesPage = await t.get('/sources');
        assert.ok(/failing since/.test(sourcesPage.text), 'the sources page says the sync is failing');
        const ready = (await t.get('/api/ready')).json();
        assert.ok(JSON.stringify(ready).includes('last Sources sync failed'));
        t.sources.setDown(false);
    });

    await check('the gate: a monetary observation older than TRADE_PRICE_MAX_AGE_SEC makes the page noindex (stale_price)', async () => {
        const acmeNow = t.ctx.instruments.bySymbol('ACME');
        assert.ok(!t.ctx.indexing.decide(acmeNow).codes.includes('stale_price'), 'observed hours ago: not yet');
        t.clock.advance(24 * HOUR);
        const d = t.ctx.indexing.decide(acmeNow);
        assert.ok(d.codes.includes('stale_price'), d.codes.join(','));
        assert.ok(!d.indexable);
    });

    await t.close();
    done();
})();
