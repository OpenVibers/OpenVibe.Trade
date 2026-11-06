'use strict';
/**
 * The market-wide brief (domain/market-briefs.js, the worker tick, the home and GET /api/v1/review-queue):
 *   - built only from what Trade stored: the day's filings by form, the euro reference rates, the companies with new
 *     filings or SEC figures and aggregate watchlist activity (no network beyond the injected AI seam)
 *   - every point cites a Trade page; an uncited point is dropped and listed as a gap
 *   - one a UTC day at most: a second ask makes no second AI call
 *   - unreviewed, the home is noindex and the brief is in the editor queue; approving it indexes the home
 *   - without OpenVibe.AI nothing is made and nothing renders
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const quiet = { log() {}, warn() {}, error() {} };
const MARKET_WORKFLOW = 'trade.summarize_market_context';

(async () => {
    const aiCalls = [];
    let advice = false;
    const ai = {
        enabled: true, WORKFLOW: MARKET_WORKFLOW,
        async run(input) {
            aiCalls.push(input);
            const form = input.sources.findIndex((s) => s.source_type === 'trade.filings_by_form');
            const rate = input.sources.findIndex((s) => s.source_type === 'trade.rate');
            const company = input.sources.findIndex((s) => s.source_type === 'trade.instrument');
            const watch = input.sources.findIndex((s) => s.source_type === 'trade.watchlists');
            return {
                runId: `run_market_${aiCalls.length}`, model: 'test-model', stub: false,
                output: {
                    summary: advice
                        ? 'We recommend buying ACME now: the latest filing makes it a sure thing.'
                        : 'Filing activity led the day, the euro reference rates moved, and one company reported a new figure.',
                    observations: [
                        { text: 'The day\'s filings were led by quarterly reports and current reports.', observed_at: null, citations: [form] },
                        { text: 'The euro was worth a little more in dollars than at the previous reference rate.', observed_at: null, citations: [rate] },
                        { text: 'ACME filed a report and Trade read a new figure from it.', observed_at: null, citations: [company] },
                        ...(watch >= 0 ? [{ text: 'People added instruments to their private watchlists.', citations: [watch] }] : []),
                        { text: 'A sentence with nothing behind it.', citations: [] },
                    ],
                    disclaimer: 'Informational only; not investment advice.',
                    citations: [form], gaps: [],
                },
            };
        },
    };

    const t = await boot({ ai, log: quiet, env: { TRADE_BRIEFS_INTERVAL_MS: '600000' } });
    try {
        const acme = await t.instrument({ symbol: 'ACME', name: 'Acme Corp', cik: '1234567' });
        const usd = await t.ctx.instruments.create({ kind: 'currency', symbol: 'USD', name: 'US Dollar' }, t.editor.subject);
        await t.observe(usd, { metric: 'rate', value: '1.1650', unit: 'ratio', currency: null, source_ref: 'rate-usd-today', observed_at: t.iso(t.T0 - 3600e3), retrieved_at: t.iso(t.T0 - 1800e3) });
        await t.observe(usd, { metric: 'rate', value: '1.1600', unit: 'ratio', currency: null, source_ref: 'rate-usd-before', observed_at: t.iso(t.T0 - 86400e3), retrieved_at: t.iso(t.T0 - 82800e3) });
        await t.ctx.documents.upsert({
            source_key: 'sec-xbrl-filings', source_item_id: 'itm_market_1', source_revision: 1, title: 'Acme Corp (0001234567) (Filer)',
            url: 'https://www.sec.gov/Archives/edgar/data/1234567/000123456726000001/0001234567-26-000001-index.htm', published_at: t.T0 - 1800e3,
            source_updated_at: null, retrieved_at: t.T0, first_seen_at: t.T0, license_note: null, terms_note: null,
            kind: 'filing', form_type: '10-Q', filer_name: 'Acme Corp', cik: '0001234567', accession: '0001234567-26-000001',
        }, acme);
        await t.observe(acme, { metric: 'revenue.q', value: '1000000', unit: 'USD', currency: 'USD', source_key: 'sec-companyfacts', source_ref: '1234567:0001234567-26-000001:Revenue:CY2026Q3', period: '3 months to 2026-09-30', observed_at: t.iso(t.T0 - 86400e3), retrieved_at: t.iso(t.T0) });
        // An instrument brief so the home has the "Latest AI briefs" section the market brief must sit above.
        await t.ctx.store.db.prepare(`INSERT INTO trade_ai_briefs (id, instrument_id, summary, points, cites, gaps, as_of, inputs_hash, run_id, model, trigger, created_at)
            VALUES ('tbr_market_seed', @iid, 'ACME filed a quarterly report.', '[]', '[]', '[]', @as_of, 'seed', 'run_seed', 'test-model', 'report', @created)`)
            .run({ iid: acme.id, as_of: t.T0, created: t.T0 });
        const watch = await t.ctx.watchlists.create(t.alice.subject, { name: 'Mine' });
        await t.ctx.watchlists.add(watch, acme);

        await check('built only from stored rows: the day\'s filings, rates, companies and watchlist count', async () => {
            const r = await t.ctx.marketBriefs.make();
            assert.strictEqual(r.created, true, JSON.stringify(r));
            assert.strictEqual(aiCalls.length, 1);
            const input = aiCalls[0];
            assert.deepStrictEqual(input.instrument, { symbol: 'MARKET', name: 'The US market: every company Trade covers' });
            assert.strictEqual(input.stale_after_hours, 24);
            assert.ok(input.sources.length > 0 && input.sources.length <= 50);
            assert.deepStrictEqual(input.sources.map((s) => s.source_type), ['trade.filings_by_form', 'trade.rate', 'trade.instrument', 'trade.watchlists']);
            assert.match(input.sources[0].snippet, /1 10-Q filings? were published or first seen in the last 24 hours/);
            assert.match(input.sources[1].snippet, /1 EUR = 1\.1650 USD on .* from 1\.1600/);
            assert.match(input.sources[2].snippet, /1 new filing \(10-Q\) and 1 new SEC figure/);
            assert.match(input.sources[3].snippet, /1 instrument was added to people's private watchlists/);
            for (const s of input.sources) assert.ok(!/^https?:/.test(s.url), `a Trade page, not the source's own URL: ${s.url}`);
            for (const s of input.sources) assert.ok(!/price/i.test(s.snippet), 'no prices in the market brief');
            const b = r.brief;
            assert.strictEqual(b.status, 'unreviewed');
            assert.strictEqual(b.points.length, 4, 'the uncited point is dropped');
            assert.ok(b.gaps.some((g) => /nothing behind it/.test(g)), 'and listed as a gap');
            assert.ok(b.points.every((p) => p.cites.length && p.cites.every((c) => c.url.startsWith('/'))), 'every claim links to a Trade page');
            assert.ok(b.cites.every((c) => c.url.startsWith('/')));
        });

        await check('one UTC day at most: a second ask makes no second AI call', async () => {
            const again = await t.ctx.marketBriefs.make();
            assert.strictEqual(again.created, false);
            assert.strictEqual(again.brief.id, (await t.ctx.marketBriefs.latest()).id);
            assert.strictEqual(aiCalls.length, 1);
            assert.strictEqual((await t.ctx.worker.marketBriefsTick()).created, 0);
            assert.strictEqual(aiCalls.length, 1);
        });

        await check('unreviewed: the home is noindex and the brief is in the editor queue with its review path', async () => {
            const home = await t.get('/');
            assert.strictEqual(home.status, 200);
            assert.ok(home.text.includes('<meta name="robots" content="noindex, nofollow">'), 'the home is noindex while the brief is unreviewed');
            assert.ok(home.text.includes('AI-written, not yet reviewed by a person'));
            assert.ok(home.text.indexOf('id="market-brief"') < home.text.indexOf('id="briefs-h"'), 'the market brief is above the instrument briefs');
            const page = await t.get('/sitemaps/pages.xml');
            assert.ok(!page.text.includes('<loc>https://openvibe.trade/</loc>'), 'the home is not in the sitemap while unreviewed');
            const no = await t.get('/api/v1/review-queue', { as: t.alice });
            assert.strictEqual(no.status, 403);
            const q = await t.get('/api/v1/review-queue', { as: t.editor });
            assert.strictEqual(q.status, 200, q.text);
            const item = q.json().items.find((i) => i.kind === 'market_brief');
            assert.ok(item, 'the market brief is waiting');
            assert.strictEqual(item.site, 'trade');
            assert.ok(item.reasons.some((x) => x.code === 'ai_generated_unreviewed'));
            assert.match(item.review.path, /^\/api\/v1\/market-briefs\/tmk_[^/]+\/review$/);
        });

        await check('approving as a person indexes the home and clears the queue item', async () => {
            const b = await t.ctx.marketBriefs.latest();
            const no = await t.get(`/api/v1/market-briefs/${b.id}/review`, { as: t.alice, json: { decision: 'approved' } });
            assert.strictEqual(no.status, 403);
            const r = await t.get(`/api/v1/market-briefs/${b.id}/review`, { as: t.editor, json: { decision: 'approved', note: 'Checked against the day\'s filings' } });
            assert.strictEqual(r.status, 201, r.text);
            assert.strictEqual(r.json().brief.reviewed, true);
            const home = await t.get('/');
            assert.ok(home.text.includes('<meta name="robots" content="index, follow">'), 'the home is indexable once reviewed');
            assert.ok(home.text.includes('AI-written, reviewed by a person'));
            const page = await t.get('/sitemaps/pages.xml');
            assert.ok(page.text.includes('<loc>https://openvibe.trade/</loc>'), 'the home is in the sitemap once reviewed');
            const q = await t.get('/api/v1/review-queue', { as: t.editor });
            assert.ok(!q.json().items.some((i) => i.kind === 'market_brief'), 'a reviewed brief leaves the queue');
            const again = await t.get(`/api/v1/market-briefs/${b.id}/review`, { as: t.editor, json: { decision: 'approved' } });
            assert.strictEqual(again.status, 409, 'a review is recorded once');
        });

        await check('the next day: a new brief, and advice is refused without storing one', async () => {
            t.clock.advance(24 * 3600e3);
            advice = true;
            await assert.rejects(() => t.ctx.marketBriefs.make(), (e) => e.status === 422 && e.code === 'market_brief.advice_refused');
            assert.strictEqual(aiCalls.length, 2);
            assert.strictEqual((await t.ctx.marketBriefs.latest()).date, '2026-09-22', 'the refused text left the previous day\'s brief alone');
            advice = false;
            const next = await t.ctx.marketBriefs.make();
            assert.strictEqual(next.created, true);
            assert.strictEqual(next.brief.date, '2026-09-23');
            assert.strictEqual(aiCalls.length, 3);
        });

        const t2 = await boot({ ai: { enabled: false, WORKFLOW: MARKET_WORKFLOW, async run() { throw new Error('OpenVibe.AI is not configured'); } }, log: quiet });
        try {
            await t2.ctx.store.db.prepare(`INSERT INTO trade_market_briefs (id, brief_date, summary, points, cites, gaps, as_of, inputs_hash, run_id, model, trigger, created_at)
                VALUES ('tmk_test_old', '2026-09-22', 'An old AI brief.', '[]', '[]', '[]', 1, 'h', 'run', 'm', 'schedule', 1)`).run();
            await check('without OpenVibe.AI nothing is made, nothing is shown and nothing fails', async () => {
                assert.strictEqual(t2.ctx.marketBriefs.enabled, false);
                assert.deepStrictEqual(await t2.ctx.marketBriefs.make(), { brief: null, created: false });
                assert.strictEqual(await t2.ctx.marketBriefs.latest(), null);
                const r = await t2.get('/');
                assert.strictEqual(r.status, 200);
                assert.ok(!r.text.includes('id="market-brief"'), 'no market brief section');
                assert.ok(r.text.includes('<meta name="robots" content="index, follow">'), 'the stale row changes nothing');
            });
        } finally {
            await t2.close();
        }
    } finally {
        await t.close();
        done();
    }
})().catch((e) => { console.error(e); process.exit(1); });
