'use strict';
/**
 * The home on a phone (the owner's rule, 2026-10-31: never hide content to shorten): the home's six kinds of market
 * information are one pick block, every pane is shown, stacked, with its own heading, and the chips are a row of
 * links that jump to a pane. The parts a reader rarely needs are folds.
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

        await check('the home is one pick block: a link per pane, every pane in the page and showing', async () => {
            const r = await t.get('/');
            assert.strictEqual(r.status, 200, r.text);
            const page = r.text;
            const block = page.slice(page.indexOf('<div class="pick" id="pick-data">'), page.indexOf('<div class="pick" id="pick-data">') + 6000);
            assert.ok(block.startsWith('<div class="pick" id="pick-data">'), 'the pick block is on the home');
            assert.ok(!/<input type="radio"/.test(block), 'no radio in the pick block');
            assert.match(block, /<nav class="pick-row" aria-label="The market, by kind">/);
            const chips = [...block.matchAll(/<a class="pick-chip" href="#([a-z]+)">[^<]+<\/a>/g)];
            assert.ok(chips.length >= 4, `a link per pane (${chips.length})`);
            // Every pane is in the page, and every link points at one of them.
            const panes = [...block.matchAll(/<div class="pick-pane" id="([a-z]+)">/g)].map((m) => m[1]);
            assert.deepStrictEqual(panes, chips.map((m) => m[1]), 'every pane is in the page, one per link');
        });

        await check('the CSS shows every pane on a phone; the chips are links, not a picker', async () => {
            const r = await t.get('/');
            const page = r.text;
            assert.ok(!page.includes('.pick:has('), 'no inline rule picks a pane');
            assert.ok(!page.includes('pk-data'), 'no radio ids on the page');
            const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'css', 'trade.css'), 'utf8');
            assert.match(css, /\.pick-head, \.pick-row \{ display: none; \}/, 'the chips are hidden by default');
            assert.match(css, /@media \(max-width: 640px\) \{/, 'the phone rules are under 640 px');
            assert.match(css, /\.pick-row \{ display: flex/, 'the chips are a row on a phone');
            assert.match(css, /\.pick-chip \{[^}]*min-height: 44px/, 'a chip is a 44 px link target');
            assert.ok(!/\.pick[^{}]*\.pick-pane[^{}]*\{[^}]*display:\s*none/.test(css), 'no rule hides a pane');
            assert.ok(!/\.pick[^{}]*:target/.test(css), 'no :target pane rule');
            assert.ok(!/\.pick[^{}]*\.pick-pane[^{}]*h2[^{}]*\{[^}]*display:\s*none/.test(css), 'a pane keeps its heading on a phone');
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
