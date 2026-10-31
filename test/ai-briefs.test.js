'use strict';
/**
 * AI market context (domain/facts.js, domain/briefs.js, the briefs tick, POST /i/:symbol/brief):
 *   - SEC's company facts become observations: only framed facts (one per period), the newest revenue concept,
 *     the last quarters and years, the period and the filing kept; a re-read records nothing new;
 *   - a filed figure is not a price: the stale-price gate ignores it;
 *   - a new report makes the tick read the numbers again, then write a brief that cites Trade's own rows;
 *   - the same inputs make no second brief; an uncited point is dropped; advice is refused; a stub run is refused;
 *   - the page labels the brief and links each point to its row; the home lists the latest briefs;
 *   - a reader's ask must come from Trade's own page, and the hourly budget holds.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { extract } = require('../server/domain/facts');

const q = (start, end, val, accn, frame, form = '10-Q') => ({ start, end, val, accn, fy: 2026, fp: 'Q3', form, filed: '2026-07-31', ...(frame ? { frame } : {}) });
const i = (end, val, accn, frame) => ({ end, val, accn, fy: 2026, fp: 'Q3', form: '10-Q', filed: '2026-07-31', ...(frame ? { frame } : {}) });
const FACTS = {
    cik: 320193, entityName: 'Apple Inc.',
    facts: {
        dei: { EntityCommonStockSharesOutstanding: { units: { shares: [i('2026-07-17', 14594180000, '0000320193-26-000020', 'CY2026Q2I')] } } },
        'us-gaap': {
            // An old revenue tag that stopped in 2018, and the one in use now: the newer one wins.
            Revenues: { units: { USD: [q('2018-07-01', '2018-09-29', 62900000000, '0000320193-18-000145', 'CY2018Q3')] } },
            RevenueFromContractWithCustomerExcludingAssessedTax: { units: { USD: [
                q('2025-03-30', '2025-06-28', 94036000000, '0000320193-25-000073', 'CY2025Q2'),
                q('2025-03-30', '2025-06-28', 94036000000, '0000320193-26-000020'),   // the comparative repeated: no frame, not read
                q('2025-12-28', '2026-03-28', 95359000000, '0000320193-26-000013', 'CY2026Q1'),
                q('2026-03-29', '2026-06-27', 109417000000, '0000320193-26-000020', 'CY2026Q2'),
                q('2024-09-29', '2025-09-27', 416161000000, '0000320193-25-000079', 'CY2025', '10-K'),
            ] } },
            EarningsPerShareDiluted: { units: { 'USD/shares': [q('2026-03-29', '2026-06-27', 2.02, '0000320193-26-000020', 'CY2026Q2')] } },
            Assets: { units: { USD: [i('2026-06-27', 383266000000, '0000320193-26-000020', 'CY2026Q2I')] } },
        },
    },
};

const quiet = { log() {}, warn() {}, error() {} };

(async () => {
    const secCalls = [];
    const sec = { enabled: true, async companyFacts(cik) { secCalls.push(cik); return { doc: FACTS, retrievedAt: t.clock.now() }; } };
    const aiCalls = [];
    let aiOutput = null;
    let aiStub = false;
    const ai = {
        enabled: true, WORKFLOW: 'trade.summarize_market_context',
        async run(input) { aiCalls.push(input); return { runId: `run_${aiCalls.length}`, model: 'test-model', stub: aiStub, output: aiOutput(input) }; },
    };
    const t = await boot({ sec, ai, log: quiet, env: { TRADE_BRIEFS_PER_HOUR: '3' } });
    const db = t.ctx.store.db;
    const apple = await t.instrument({ symbol: 'AAPL', name: 'Apple Inc.', cik: '320193', exchange: 'Nasdaq' });
    const rev = (input) => input.sources.findIndex((s) => /Revenue \(quarter\)/.test(s.title));
    aiOutput = (input) => ({
        summary: 'Apple reported revenue of 109.4 billion US dollars for the three months to 27 June 2026, up from 94.0 billion a year earlier.',
        observations: [
            { text: 'Quarterly revenue rose from 94,036 million USD to 109,417 million USD year over year.', observed_at: '2026-06-27', citations: [rev(input)] },
            { text: 'A sentence with nothing behind it.', citations: [] },
        ],
        disclaimer: 'Informational only; not investment advice.', citations: [rev(input)], gaps: [],
    });

    await check('SEC facts: framed facts only, the newest concept, periods and filings kept; a re-read adds nothing', async () => {
        const rows = extract(FACTS);
        const revq = rows.filter((r) => r.metric === 'revenue.q');
        assert.deepStrictEqual(revq.map((r) => [r.value, r.period, r.concept]), [
            ['109417000000', '3 months to 2026-06-27', 'us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax'],
            ['95359000000', '3 months to 2026-03-28', 'us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax'],
            ['94036000000', '3 months to 2025-06-28', 'us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax'],
        ]);
        assert.deepStrictEqual(rows.filter((r) => r.metric === 'revenue.fy').map((r) => r.period), ['12 months to 2025-09-27']);
        assert.deepStrictEqual(rows.find((r) => r.metric === 'shares_outstanding'), { ...rows.find((r) => r.metric === 'shares_outstanding'), unit: 'shares', currency: null, period: 'at 2026-07-17' });
        assert.strictEqual(rows.find((r) => r.metric === 'eps_diluted.q').unit, 'USD/shares');

        const r = await t.ctx.facts.record(apple);
        assert.strictEqual(r.recorded, rows.length, JSON.stringify(r));
        const again = await t.ctx.facts.record(apple);
        assert.strictEqual(again.recorded, 0);
        assert.strictEqual(again.unchanged, rows.length);
        const o = await db.prepare("SELECT * FROM trade_market_observations WHERE instrument_id = ? AND metric = 'revenue.q' ORDER BY observed_at DESC LIMIT 1").get(apple.id);
        assert.strictEqual(o.source_key, 'sec-companyfacts');
        assert.strictEqual(o.source_url, 'https://www.sec.gov/Archives/edgar/data/320193/000032019326000020/');
        assert.strictEqual(o.source_ref, '0000320193:0000320193-26-000020:us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax:CY2026Q2');
        const decision = await t.ctx.indexing.decide(apple);
        assert.ok(!decision.reasons || !decision.reasons.includes('stale_price'), `a filed figure is not a stale price: ${JSON.stringify(decision.reasons)}`);
    });

    await check('a new report: the tick reads the numbers again and writes a brief citing Trade\'s own rows', async () => {
        t.clock.advance(60_000);
        await t.ctx.documents.upsert({
            source_key: 'sec-xbrl-filings', source_item_id: 'itm_01J8Z3V9Q6N1X2Y3Z4A5B6C7D8', source_revision: 1, title: 'Apple Inc. (0000320193) (Filer)',
            url: 'https://www.sec.gov/Archives/edgar/data/320193/000032019326000090/0000320193-26-000090-index.htm', published_at: t.clock.now() - 1000,
            source_updated_at: null, retrieved_at: t.clock.now(), first_seen_at: t.clock.now(), license_note: null, terms_note: null,
            kind: 'filing', form_type: '10-Q', filer_name: 'Apple Inc.', cik: '0000320193', accession: '0000320193-26-000090',
        }, apple);
        const calls = secCalls.length;
        const tick = await t.ctx.worker.briefsTick();
        assert.deepStrictEqual(tick, { facts: 1, briefs: 1, failed: 0 });
        assert.strictEqual(secCalls.length, calls + 1, 'the numbers were read again after the report');
        const input = aiCalls[aiCalls.length - 1];
        assert.deepStrictEqual(input.instrument, { symbol: 'AAPL', name: 'Apple Inc.', exchange: 'Nasdaq' });
        assert.ok(input.sources.length <= 50 && input.sources.some((s) => s.source_type === 'trade.sec_fact') && input.sources.some((s) => s.source_type === 'trade.sec_filing'));
        assert.match(input.sources[rev(input)].content, /3 months to 2026-06-27: 109417000000 USD \(filing 0000320193-26-000020\)/);
        const b = await t.ctx.briefs.latest(apple);
        assert.strictEqual(b.points.length, 1, 'the uncited point is dropped');
        assert.ok(b.gaps.some((g) => /nothing behind it/.test(g)), 'and listed as a gap');
        assert.ok(b.points[0].cites.every((c) => c.kind === 'observation' && /^obs_/.test(c.id)));
        assert.strictEqual(b.authorship.reviewed, false);
        assert.strictEqual(b.as_of, '2026-06-27T00:00:00.000Z');
        assert.deepStrictEqual(await t.ctx.worker.briefsTick(), { facts: 0, briefs: 0, failed: 0 }, 'nothing new, nothing written');
    });

    await check('the page labels the brief and links each point to its row; the home lists it', async () => {
        const page = await t.get('/i/AAPL');
        assert.strictEqual(page.status, 200);
        assert.ok(page.text.includes('AI-written, not reviewed by a person'));
        const b = await t.ctx.briefs.latest(apple);
        assert.ok(page.text.includes(`href="#${b.points[0].cites[0].id}"`), 'the citation links to the observation row');
        for (const c of b.points.flatMap((p) => p.cites)) assert.ok(page.text.includes(`id="${c.id}"`), `cited row ${c.id} is on the page`);
        assert.strictEqual(b.points[0].cites.length, 1, 'a series is cited once, by its newest row');
        assert.ok(page.text.includes('<data value="109417000000">109,417,000,000</data> <small>USD</small>'), 'the stated value, digit for digit, grouped');
        assert.ok(page.text.indexOf('Revenue (quarter)') < page.text.indexOf('Revenue (year)') && page.text.indexOf('Revenue (year)') < page.text.indexOf('Total assets'), 'statement order');
        assert.ok(page.text.includes('not investment advice'));
        const home = await t.get('/');
        assert.ok(home.text.includes('Latest AI briefs') && home.text.includes('#ai-brief'));
    });

    await check('the same inputs make no second brief; advice and stub runs are refused', async () => {
        const n = aiCalls.length;
        const same = await t.ctx.briefs.make(apple, { trigger: 'reader' });
        assert.strictEqual(same.created, false);
        assert.strictEqual(aiCalls.length, n, 'the model was not asked again');
        const msft = await t.instrument({ symbol: 'MSFT', name: 'Microsoft', cik: '789019' });
        await t.ctx.facts.record(msft);
        const keep = aiOutput;
        aiOutput = () => ({ summary: 'Strong buy: you should buy before the price target is reached.', observations: [], citations: [0], gaps: [] });
        await assert.rejects(t.ctx.briefs.make(msft), (e) => e.code === 'brief.advice_refused');
        aiOutput = keep;
        aiStub = true;
        await assert.rejects(t.ctx.briefs.make(msft), (e) => e.code === 'brief.stub');
        aiStub = false;
        assert.strictEqual(await t.ctx.briefs.latest(msft), null, 'nothing kept');
    });

    await check('a reader asks from Trade\'s own page only, and the hourly budget holds', async () => {
        const cross = await t.get('/i/MSFT/brief', { method: 'POST', headers: { origin: 'https://evil.example' } });
        assert.strictEqual(cross.status, 403);
        const ok = await t.get('/i/MSFT/brief', { method: 'POST', headers: { origin: 'https://openvibe.trade' } });
        assert.strictEqual(ok.status, 303, ok.text.slice(0, 300));
        assert.match(ok.headers.get('location'), /^\/i\/MSFT\?n=brief_made#ai-brief$/);
        const again = await t.get('/i/MSFT/brief', { method: 'POST', headers: { referer: 'https://openvibe.trade/i/MSFT' } });
        assert.match(again.headers.get('location'), /n=brief_current/);
        // Two briefs this hour (AAPL, MSFT) and a budget of three: one more, then 429.
        const nvda = await t.instrument({ symbol: 'NVDA', name: 'NVIDIA', cik: '1045810' });
        await t.ctx.facts.record(nvda);
        const goog = await t.instrument({ symbol: 'GOOGL', name: 'Alphabet', cik: '1652044' });
        await t.ctx.facts.record(goog);
        aiOutput = (input) => ({ summary: `Figures for ${input.instrument.symbol}.`, observations: [], citations: [0], gaps: [] });
        assert.strictEqual((await t.ctx.briefs.make(nvda)).created, true);
        await assert.rejects(t.ctx.briefs.make(goog), (e) => e.code === 'brief.budget');
        t.clock.advance(3600_000 + 1);
        assert.strictEqual((await t.ctx.briefs.make(goog)).created, true, 'the next hour has room again');
    });

    await t.close();
    done();
})();
