'use strict';
/**
 * No observation → no number shown. Every datum exposes its observation and source timestamps.
 * Observations are immutable and idempotent per source reference.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const feed = t.network.serviceToken('feed', ['trade.observation.write']);
    const acme = t.instrument({ symbol: 'ACME', name: 'Acme Corp', cik: '1234567' });

    await check('an instrument without observations shows no number, in HTML and JSON', async () => {
        const page = await t.get('/i/ACME');
        assert.strictEqual(page.status, 200);
        assert.ok(page.text.includes('No observations have been recorded for ACME, so no number is shown.'));
        assert.ok(!/<table class="data observations"/.test(page.text), 'no observations table');
        assert.ok(!/<data value=/.test(page.text), 'no <data> value element');
        const json = (await t.get('/i/ACME.json')).json();
        assert.deepStrictEqual(json.observations, []);
        assert.ok(!('price' in json) && !('value' in json.instrument), 'no invented top-level value');
    });

    await check('an observation without observed_at or retrieved_at is refused, never defaulted to now', async () => {
        const noObserved = await t.get('/api/v1/observations', { as: feed, json: { symbol: 'ACME', metric: 'price.close', value: '10.5', unit: 'USD', currency: 'USD', source_key: 'test-feed', source_ref: 'r1', retrieved_at: t.iso(t.T0) } });
        assert.strictEqual(noObserved.status, 422);
        assert.strictEqual(noObserved.json().code, 'observation.time_required');
        const noRetrieved = await t.get('/api/v1/observations', { as: feed, json: { symbol: 'ACME', metric: 'price.close', value: '10.5', unit: 'USD', source_key: 'test-feed', source_ref: 'r1', observed_at: t.iso(t.T0) } });
        assert.strictEqual(noRetrieved.status, 422);
        const future = await t.get('/api/v1/observations', { as: feed, json: { symbol: 'ACME', metric: 'price.close', value: '10.5', unit: 'USD', source_key: 'test-feed', source_ref: 'r1', observed_at: t.iso(t.T0 + 3600e3), retrieved_at: t.iso(t.T0) } });
        assert.strictEqual(future.status, 422);
        const noValue = await t.get('/api/v1/observations', { as: feed, json: { symbol: 'ACME', metric: 'price.close', value: 'about ten', unit: 'USD', source_key: 'test-feed', source_ref: 'r1', observed_at: t.iso(t.T0), retrieved_at: t.iso(t.T0) } });
        assert.strictEqual(noValue.status, 422);
        assert.strictEqual(t.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM trade_market_observations').get().n, 0);
    });

    await check('only a service with trade.observation.write records observations; people cannot', async () => {
        const body = { symbol: 'ACME', metric: 'price.close', value: '10.5', unit: 'USD', source_key: 'test-feed', source_ref: 'r1', observed_at: t.iso(t.T0 - 60e3), retrieved_at: t.iso(t.T0) };
        assert.strictEqual((await t.get('/api/v1/observations', { as: t.network.serviceToken('other', ['trade.context.read']), json: body })).status, 403);
        assert.strictEqual((await t.get('/api/v1/observations', { as: t.editor, json: body })).status, 403);
        assert.strictEqual((await t.get('/api/v1/observations', { json: body })).status, 403);
    });

    let obsId;
    await check('a recorded observation shows its value with observed_at, retrieved_at and source', async () => {
        const r = await t.get('/api/v1/observations', { as: feed, json: { symbol: 'ACME', metric: 'price.close', value: '10.50', unit: 'USD', currency: 'USD', source_key: 'test-feed', source_ref: 'r1', source_url: 'https://example.org/acme/close', observed_at: '2026-09-22T11:59:00Z', retrieved_at: '2026-09-22T12:00:00Z' } });
        assert.strictEqual(r.status, 201, r.text);
        const o = r.json().observation;
        obsId = o.id;
        assert.strictEqual(o.value, '10.50', 'the decimal exactly as stated');
        assert.strictEqual(o.observed_at, '2026-09-22T11:59:00.000Z');
        assert.strictEqual(o.retrieved_at, '2026-09-22T12:00:00.000Z');
        assert.strictEqual(o.source.key, 'test-feed');
        const page = await t.get('/i/ACME');
        assert.ok(page.text.includes('<data value="10.50">10.50</data>'));
        assert.ok(page.text.includes('datetime="2026-09-22T11:59:00.000Z"'), 'observed_at shown');
        assert.ok(page.text.includes('datetime="2026-09-22T12:00:00.000Z"'), 'retrieved_at shown');
        assert.ok(page.text.includes('href="https://example.org/acme/close"'));
        const json = (await t.get('/i/ACME.json')).json();
        assert.strictEqual(json.observations.length, 1);
        for (const k of ['observed_at', 'retrieved_at', 'recorded_at']) assert.ok(json.observations[0][k], k);
        assert.ok(json.observations[0].freshness, 'every observation carries its freshness');
        const ev = t.events('trade.observation.created');
        assert.strictEqual(ev.length, 1);
        assert.strictEqual(ev[0].payload.observed_at, '2026-09-22T11:59:00.000Z');
        assert.strictEqual(ev[0].payload.retrieved_at, '2026-09-22T12:00:00.000Z');
    });

    await check('the same source reference again is a replay (200, no second row or event); a different value is 409', async () => {
        const same = await t.get('/api/v1/observations', { as: feed, json: { symbol: 'ACME', metric: 'price.close', value: '10.50', unit: 'USD', currency: 'USD', source_key: 'test-feed', source_ref: 'r1', observed_at: '2026-09-22T11:59:00Z', retrieved_at: '2026-09-22T12:00:00Z' } });
        assert.strictEqual(same.status, 200);
        assert.strictEqual(same.json().created, false);
        assert.strictEqual(same.json().observation.id, obsId);
        const diff = await t.get('/api/v1/observations', { as: feed, json: { symbol: 'ACME', metric: 'price.close', value: '11', unit: 'USD', currency: 'USD', source_key: 'test-feed', source_ref: 'r1', observed_at: '2026-09-22T11:59:00Z', retrieved_at: '2026-09-22T12:00:00Z' } });
        assert.strictEqual(diff.status, 409);
        assert.strictEqual(t.events('trade.observation.created').length, 1);
    });

    await check('observations are immutable in the database', async () => {
        assert.throws(() => t.ctx.store.db.prepare("UPDATE trade_market_observations SET value = '99' WHERE id = ?").run(obsId), /immutable/);
        assert.throws(() => t.ctx.store.db.prepare('DELETE FROM trade_market_observations WHERE id = ?').run(obsId), /immutable/);
    });

    await check('history keeps every observation, newest first, each with its timestamps', async () => {
        t.observe(acme, { metric: 'price.close', value: '10.75', source_ref: 'r2', observed_at: '2026-09-22T12:01:00Z', retrieved_at: '2026-09-22T12:02:00Z' });
        const h = (await t.get('/api/v1/instruments/ACME/observations?metric=price.close')).json();
        assert.deepStrictEqual(h.observations.map((o) => o.value), ['10.75', '10.50']);
        const latest = (await t.get('/i/ACME.json')).json().observations;
        assert.strictEqual(latest.length, 1, 'latest per metric');
        assert.strictEqual(latest[0].value, '10.75');
    });

    await check('JSON-LD carries only real fields (no price, no rating, no invented date)', async () => {
        const page = await t.get('/i/ACME');
        const blocks = [...page.text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
        assert.ok(blocks.length >= 1);
        const flat = JSON.stringify(blocks);
        for (const k of ['price', 'offers', 'aggregateRating', 'ratingValue', 'datePublished']) assert.ok(!flat.includes(`"${k}"`), k);
        const pageLd = blocks.find((b) => b['@type'] === 'WebPage');
        assert.strictEqual(pageLd.about.tickerSymbol, 'ACME');
        assert.ok(!('dateModified' in pageLd), 'no context published → no dateModified');
    });

    await t.close();
    done();
})();
