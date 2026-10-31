'use strict';
/**
 * The market-research outcomes the data supports (research-2026-10-30/market/outcomes/trade.md):
 *   1. every observation shows when the value was true and when it was fetched, and a value past its
 *      max_age is stale (the max age itself is shown);
 *   2. every observation shows its source URL and the source's own reference for the datum;
 *   3. the instrument page carries the "Free, always" line;
 *   4. a watchlist add and a new-filing alert are one tap from the page (and still work for a person
 *      with no watchlist yet);
 *   5. no "no cap" claim: the page states the configured limits instead (the caps are real);
 *   6. a price is labelled as a source-stated value, not a live quote, with no invented delay;
 *   7. the AI brief stays labelled and cites the page, and the disclaimer is on the page.
 * Outcome 7's brief rendering is covered by test/ai-briefs.test.js; here it is the page's note.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const HOUR = 3600e3;

(async () => {
    const t = await boot();
    const acme = await t.instrument({ symbol: 'ACME', name: 'Acme Corp', exchange: 'NYSE' });
    const { observation } = await t.observe(acme, {
        metric: 'price.close', value: '10.50', unit: 'USD', currency: 'USD',
        source_key: 'test-feed', source_url: 'https://example.org/acme/2026-09-22',
        source_ref: 'ACME-2026-09-22-close', max_age_sec: 3600,
        observed_at: t.iso(t.T0 - 60e3), retrieved_at: t.iso(t.T0),
    });

    await check('an observation shows its observation time, retrieval time, max age and source reference', async () => {
        const r = await t.get('/i/ACME');
        assert.strictEqual(r.status, 200);
        const html = r.text;
        assert.ok(html.includes('>Timestamps</th>'), 'the two times have a column');
        assert.ok(html.includes('Observed <time'), 'the observation time has a label');
        assert.ok(html.includes('Retrieved <time'), 'the retrieval time has a label');
        assert.ok(html.includes(`datetime="${t.iso(t.T0 - 60e3)}"`), 'when the value was true');
        assert.ok(html.includes(`datetime="${t.iso(t.T0)}"`), 'when we fetched it');
        assert.ok(html.includes('ACME-2026-09-22-close'), 'the source\'s own reference for the datum');
        assert.ok(html.includes('https://example.org/acme/2026-09-22'), 'the source URL, as text and as a link');
        assert.ok(html.includes('Current; stale after 1 hour from the observed time.'), 'max_age_sec rendered, not a hand-typed number');
        assert.ok(!html.includes('The value is older than its 1 hour maximum age.'), 'current while inside the max age');
        assert.ok(html.includes(`id="${observation.id}"`), 'the row has the id the AI brief cites');
        const obsAt = html.indexOf('id="obs-h"');
        const personalAt = html.indexOf('id="personal-h"');
        assert.ok(obsAt > 0 && obsAt < personalAt, 'the observations stay the main job; the watch tools follow them');
    });

    await check('the "Free, always" line is on the instrument page, with no paid tier, card or trial', async () => {
        const html = (await t.get('/i/ACME')).text;
        assert.ok(html.includes('<strong>Free, always.</strong> No paid tier, no card, no trial.'));
        assert.ok(html.indexOf('id="obs-h"') < html.indexOf('Free, always'), 'it labels the observations themselves, not a block above them');
    });

    await check('a price is labelled source-stated, not a live quote; no delay is invented', async () => {
        const html = (await t.get('/i/ACME')).text;
        assert.ok(html.includes('not a live quote'), 'the row says it is not a live quote');
        assert.ok(html.includes('Trade holds no live market feed and records no source delay.'), 'the unknown delay is stated plainly');
        const other = await t.instrument({ symbol: 'FIG', name: 'Filed Figures Co' });
        await t.observe(other, { metric: 'revenue.q', value: '1000', unit: 'USD', currency: 'USD', source_ref: 'rev-1', observed_at: t.iso(t.T0 - 60e3), retrieved_at: t.iso(t.T0) });
        assert.ok(!(await t.get('/i/FIG')).text.includes('not a live quote'), 'a filed figure is not called a quote');
    });

    await check('past max_age the value stays, marked stale with the reason', async () => {
        t.clock.advance(4 * HOUR);
        const r = await t.get('/i/ACME');
        assert.ok(r.text.includes('<span class="badge stale">stale</span> since'), 'the stale verdict keeps its stale-since time');
        assert.ok(r.text.includes('The value is older than its 1 hour maximum age.'), 'the reason is max age, not source staleness');
        assert.ok(r.text.includes('<data value="10.50">10.50</data>'), 'the old value is never replaced');
    });

    await check('one tap adds the instrument to a watchlist, creating "Watching" when there is none', async () => {
        const before = await t.ctx.watchlists.forOwner(t.alice.subject);
        assert.deepStrictEqual(before, []);
        const page = await t.get('/i/ACME', { as: t.alice });
        assert.ok(page.text.includes('action="/watchlists/watch"'), 'the one-tap watch form is on the page');
        assert.ok(page.text.includes('Alert me to new filings'));
        const r = await t.get('/watchlists/watch', { as: t.alice, form: { _csrf: t.csrf(t.alice), symbol: 'ACME' } });
        assert.strictEqual(r.status, 303);
        assert.strictEqual(r.headers.get('location'), '/i/ACME?n=item_added');
        const lists = await t.ctx.watchlists.forOwner(t.alice.subject);
        assert.strictEqual(lists.length, 1);
        assert.strictEqual(lists[0].name, 'Watching');
        assert.deepStrictEqual((await t.ctx.watchlists.items(lists[0])).map((i) => i.symbol), ['ACME']);
        assert.ok((await t.get('/i/ACME', { as: t.alice })).text.includes('Add to watchlist'), 'the next tap adds to the existing list');
    });

    await check('one tap creates a new-filing alert for the instrument', async () => {
        const r = await t.get('/alerts', { as: t.alice, form: { _csrf: t.csrf(t.alice), symbol: 'ACME', kind: 'new_document' } });
        assert.strictEqual(r.status, 303);
        const rules = await t.ctx.alerts.forOwner(t.alice.subject);
        assert.strictEqual(rules.length, 1);
        assert.strictEqual(rules[0].kind, 'new_document');
        assert.strictEqual(rules[0].instrument.symbol, 'ACME');
    });

    await check('the page states the configured watchlist and alert limits, and makes no "no cap" claim', async () => {
        const html = (await t.get('/i/ACME', { as: t.alice })).text;
        const limits = t.ctx.config.limits;
        assert.ok(html.includes(`up to ${limits.watchlistsPerSubject} watchlists`), 'the watchlist cap is named from config');
        assert.ok(html.includes(`up to ${limits.alertRulesPerSubject} alert rules`), 'the alert cap is named from config');
        assert.ok(!/no (symbol|list|watchlist) cap/i.test(html), 'no unbacked no-cap claim');
    });

    await check('every page keeps the disclaimer; the AI brief label and citations are covered by test/ai-briefs.test.js', async () => {
        const page = await t.get('/i/ACME');
        const disclaimer = 'Information only — not investment advice; no trading here.';
        assert.ok(page.text.split(disclaimer).length - 1 >= 2, 'disclaimer in the page head and foot');
        assert.ok((await t.get('/i/ACME.json')).json().disclaimer === disclaimer, 'the JSON twin carries it too');
    });

    await t.close();
    done();
})();
