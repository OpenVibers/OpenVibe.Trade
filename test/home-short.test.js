'use strict';
/**
 * The home on a phone (the owner's short-pages rule, 2026-10-30): the home's six kinds of market information are
 * one pick block, a row of chips picks one of them, and the parts a reader rarely needs are folds. Radio inputs and
 * :has(), no script for the chips; every pane stays in the page for crawlers; a wider screen shows them all and no
 * chips.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const quiet = { log() {}, warn() {}, error() {} };

(async () => {
    const t = await boot({ log: quiet });
    const db = t.ctx.store.db;
    try {
        // The data the home's panes show: a currency with a rate, a company with a price, a filing and a brief.
        const usd = await t.ctx.instruments.create({ kind: 'currency', symbol: 'USD', name: 'US Dollar' }, 'usr_test');
        await t.observe(usd, { metric: 'rate', value: '1.0925', unit: 'ratio', source_ref: 'rate-usd-1', observed_at: t.iso(t.T0 - 86400e3), retrieved_at: t.iso(t.T0 - 43200e3) });
        const acme = await t.instrument({ symbol: 'ACME', name: 'Acme Corp', cik: '1234567' });
        await t.observe(acme, { metric: 'price.close', value: '10.50', source_ref: 'price-acme-1', observed_at: t.iso(t.T0 - 3600e3), retrieved_at: t.iso(t.T0 - 1800e3) });
        t.sources.setSource('sec-xbrl-filings', { lastSuccessAt: t.iso(t.T0 - 60e3), staleAfterSec: 2700 });
        t.sources.putItem({ canonical_url: 'https://www.sec.gov/Archives/edgar/data/1234567/000123456726000001/0001234567-26-000001-index.htm', title: 'ACME CORP', summary: '10-K', published_at: '2026-09-22T10:00:00Z', retrieved_at: '2026-09-22T10:05:00Z' });
        await t.ctx.sync.run();
        await db.prepare(`INSERT INTO trade_ai_briefs (id, instrument_id, summary, points, cites, gaps, as_of, inputs_hash, run_id, model, trigger, created_at)
            VALUES ('tbr_test_1', @iid, 'A short brief.', '[]', '[]', '[]', @as_of, 'h1', 'run_1', 'test-model', 'report', @created)`)
            .run({ iid: acme.id, as_of: t.T0, created: t.T0 });

        await check('the home is one pick block: a chip per pane, the first picked, every pane in the page', async () => {
            const r = await t.get('/');
            assert.strictEqual(r.status, 200, r.text);
            const page = r.text;
            const block = page.slice(page.indexOf('<div class="pick" id="pick-data">'), page.indexOf('<div class="pick" id="pick-data">') + 6000);
            assert.ok(block.startsWith('<div class="pick" id="pick-data">'), 'the pick block is on the home');
            assert.match(block, /<div class="pick-row" role="radiogroup" aria-label="The market, by kind">/);
            const chips = [...block.matchAll(/<input type="radio" name="pick-data" id="pk-data-([a-z]+)" value="\1"( checked)?><label for="pk-data-\1">([^<]+)<\/label>/g)];
            assert.ok(chips.length >= 4, `a chip per pane (${chips.length})`);
            assert.deepStrictEqual(chips.filter((m) => m[2]).map((m) => m[1]), [chips[0][1]], 'the first pane is picked');
            // Every pane stays in the page, with the id its chip picks.
            const panes = [...block.matchAll(/<div class="pick-pane" id="([a-z]+)">/g)].map((m) => m[1]);
            assert.deepStrictEqual(panes, chips.map((m) => m[1]), 'every pane is in the page, one per chip');
        });

        await check('the CSS guard: the chips are hidden and the panes all show until 640 px and where :has() is understood', async () => {
            const r = await t.get('/');
            const page = r.text;
            assert.match(page, /<style>@supports selector\(:has\(\*\)\)\{@media \(max-width:640px\)\{\.pick:has\(#pk-data-briefs:checked\) #briefs\{display:block\}/, 'the rule that shows the picked pane');
            const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'css', 'trade.css'), 'utf8');
            assert.match(css, /\.pick-row \{ display: none; \}/, 'the chips are hidden by default');
            assert.match(css, /@supports selector\(:has\(\*\)\) \{ @media \(max-width: 640px\) \{/, 'the phone rules are under :has() and 640 px');
            assert.match(css, /\.pick-row label \{[^}]*min-height: 44px/, 'a chip is a 44 px target');
            assert.match(css, /\.pick \.pick-pane \{ display: none; \}/, 'the panes are hidden on a phone');
        });

        await check('the parts a reader rarely needs are folds, open in the page and closed on a phone', async () => {
            const r = await t.get('/');
            const page = r.text;
            for (const id of ['faq', 'shipped']) {
                assert.ok(page.includes(`<details class="tr-fold tr-fold-block" id="${id}" open>`), `${id} is a fold, open in the page`);
                assert.ok(page.includes(`document.getElementById("${id}")`), `${id} has the script that closes it on a phone`);
            }
            // The content of the folds stays in the page.
            assert.match(page, /<h2 id="faq-h">Questions and answers<\/h2>/);
            assert.match(page, /Is this investment advice\?/);
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
