'use strict';
/**
 * Context: OpenVibe.AI's trade.summarize_market_context is a seam — its output is a draft context
 * revision, labelled, never attributed to a person, noindex (the page stays out of sitemaps and
 * Search) until a person on the editor list approves it. Editors write context with plain forms.
 * Text that reads as advice is refused.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const errOf = (r) => new URL(r.headers.get('location'), 'https://x').searchParams.get('e') || '';
const WORDS = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

(async () => {
    const t = await boot();
    const acme = t.instrument({ symbol: 'ACME', name: 'Acme Corp', cik: '1234567' });
    const { observation } = t.observe(acme, { metric: 'price.close', value: '10.50', source_ref: 'a', observed_at: t.iso(t.T0 - 60e3), retrieved_at: t.iso(t.T0) });
    t.ctx.freshness.report('test-feed', { status: 'healthy', lastSuccessAt: t.T0, staleAfterSec: 86400 });
    const ai = t.network.serviceToken('ai', ['trade.context.read', 'trade.context.propose']);
    let input;

    await check('the AI workflow input lists numbered sources with observation/retrieval times and staleness', async () => {
        const r = await t.get('/api/v1/instruments/ACME/context/input', { as: ai });
        assert.strictEqual(r.status, 200, r.text);
        input = r.json();
        assert.strictEqual(input.workflow, 'trade.summarize_market_context');
        assert.strictEqual(input.input.instrument.symbol, 'ACME');
        const s = input.input.sources[0];
        assert.strictEqual(s.source_type, 'trade.observation');
        assert.strictEqual(s.source_id, observation.id);
        assert.strictEqual(s.observed_at, t.iso(t.T0 - 60e3));
        assert.strictEqual(s.retrieved_at, t.iso(t.T0));
        assert.strictEqual(s.provenance.stale, false);
        assert.strictEqual(input.input.stale_after_hours, 24);
    });

    let draftRev;
    await check('AI output becomes a labelled DRAFT: not published, needs review, page not indexable', async () => {
        const r = await t.get('/api/v1/instruments/ACME/context', {
            as: ai, headers: { 'x-ov-origin': 'ai' },
            json: {
                workflow: { id: 'trade.summarize_market_context', run_id: 'run_01JABCDEFGHJKMNPQRSTVWXYZ0', version: 1 },
                input_sources: input.input.sources.map((s) => ({ source_type: s.source_type, source_id: s.source_id })),
                output: { summary: `The latest recorded close for ACME is 10.50 USD. ${WORDS(70)}`, observations: [{ text: 'Close of 10.50 USD', observed_at: t.iso(t.T0 - 60e3), citations: [0] }], stale_sources: [], disclaimer: 'Informational only; not investment advice.', citations: [0], gaps: ['No filings were provided.'] },
            },
        });
        assert.strictEqual(r.status, 201, r.text);
        const rev = r.json().revision;
        draftRev = rev.revision;
        assert.strictEqual(r.json().published, false);
        assert.strictEqual(rev.needs_review, true);
        assert.strictEqual(rev.authorship.mode, 'ai');
        assert.deepStrictEqual(rev.authorship.authors, [], 'never attributed to a person');
        assert.strictEqual(rev.authorship.workflow.id, 'trade.summarize_market_context');
        assert.strictEqual(rev.disclosure.short, 'AI-generated');
        assert.strictEqual(rev.as_of, t.iso(t.T0 - 60e3), 'as_of = newest cited observation time');
        assert.deepStrictEqual(rev.cites, [{ kind: 'observation', id: observation.id, observation: rev.cites[0].observation }]);
        const page = await t.get('/i/ACME');
        assert.ok(page.text.includes('No reviewed context has been published'));
        assert.ok(!page.text.includes('latest recorded close for ACME'), 'the draft is not shown to readers');
        assert.ok(page.text.includes('<meta name="robots" content="noindex, nofollow">'));
        assert.ok(!(await t.get('/sitemaps/instruments.xml')).text.includes('/i/ACME'));
        assert.strictEqual(t.events('trade.index_document.upserted').length, 0);
    });

    await check('AI output cannot be published without a person, nor delivered as if by a person', async () => {
        const pub = await t.get(`/editor/i/ACME/context/${draftRev}/publish`, { as: t.editor, form: { _csrf: t.csrf(t.editor) } });
        assert.strictEqual(pub.status, 303);
        assert.ok(/review/i.test(errOf(pub)));
        assert.strictEqual(t.ctx.instruments.bySymbol('ACME').context_published_revision, null);
        const svcReview = await t.get(`/api/v1/instruments/ACME/context/revisions/${draftRev}/review`, { as: ai, json: { decision: 'approved' } });
        assert.strictEqual(svcReview.status, 403, 'a service cannot review');
        const noRun = await t.get('/api/v1/instruments/ACME/context', { as: ai, headers: { 'x-ov-origin': 'ai' }, json: { workflow: { id: 'trade.summarize_market_context' }, output: { summary: 'x' } } });
        assert.strictEqual(noRun.status, 422);
        const wrongWf = await t.get('/api/v1/instruments/ACME/context', { as: ai, headers: { 'x-ov-origin': 'ai' }, json: { workflow: { id: 'blog.draft_post', run_id: 'r' }, output: { summary: 'x' } } });
        assert.strictEqual(wrongWf.status, 422);
        const asUser = await t.get('/api/v1/instruments/ACME/context', { as: ai, json: { body: 'hello' } });
        assert.strictEqual(asUser.status, 403, 'a service without X-OV-Origin: ai and without an editor subject cannot write context');
        const badCite = await t.get('/api/v1/instruments/ACME/context', { as: ai, headers: { 'x-ov-origin': 'ai' }, json: { workflow: { id: 'trade.summarize_market_context', run_id: 'r2' }, input_sources: [{ source_type: 'trade.observation', source_id: 'obs_NOPE' }], output: { summary: 'x', citations: [0] } } });
        assert.strictEqual(badCite.status, 422);
    });

    await check('advice is refused, from the AI and from editors alike', async () => {
        const r = await t.get('/api/v1/instruments/ACME/context', { as: ai, headers: { 'x-ov-origin': 'ai' }, json: { workflow: { id: 'trade.summarize_market_context', run_id: 'r3' }, input_sources: [], output: { summary: 'You should buy ACME now; price target 20.' } } });
        assert.strictEqual(r.status, 422);
        assert.strictEqual(r.json().code, 'context.advice_refused');
        const f = await t.get('/editor/i/ACME/context', { as: t.editor, form: { _csrf: t.csrf(t.editor), body: 'We recommend holding ACME.', expected_revision: String(draftRev), publish: '1' } });
        assert.strictEqual(f.status, 303);
        assert.ok(/information only/i.test(errOf(f)));
    });

    await check('a person on the editor list approves the draft: published, disclosed, indexable, in the sitemap and Search', async () => {
        const nonEditor = await t.get(`/editor/i/ACME/context/${draftRev}/review`, { as: t.alice, form: { _csrf: t.csrf(t.alice), decision: 'approved' } });
        assert.strictEqual(nonEditor.status, 403);
        const r = await t.get(`/editor/i/ACME/context/${draftRev}/review`, { as: t.editor, form: { _csrf: t.csrf(t.editor), decision: 'approved', note: 'Checked against the source.' } });
        assert.strictEqual(r.status, 303);
        const page = await t.get('/i/ACME');
        assert.ok(page.text.includes('latest recorded close for ACME'));
        assert.ok(page.text.includes('AI-generated'), 'the label stays after review');
        assert.ok(page.text.includes('reviewed by a person'));
        assert.ok(page.text.includes('<meta name="robots" content="index, follow">'), page.text.match(/<meta name="robots"[^>]*>/)[0]);
        const sm = (await t.get('/sitemaps/instruments.xml')).text;
        assert.ok(sm.includes('https://openvibe.trade/i/ACME'));
        const up = t.events('trade.index_document.upserted');
        assert.strictEqual(up.length, 1);
        assert.strictEqual(up[0].payload.authorship, 'ai_generated');
        assert.strictEqual(up[0].payload.visibility, 'public');
        const ld = [...page.text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
        assert.ok(ld.find((b) => b['@type'] === 'WebPage').dateModified, 'dateModified is the real publication time');
    });

    await check('an editor writes human context with a plain form; a stale base is refused without losing the published text', async () => {
        const head = t.ctx.context.head(t.ctx.instruments.bySymbol('ACME')).number;
        const ok = await t.get('/editor/i/ACME/context', { as: t.editor, form: { _csrf: t.csrf(t.editor), body: `Acme filed nothing new this week. ${WORDS(70)}`, expected_revision: String(head), cite: `observation:${observation.id}`, publish: '1' } });
        assert.strictEqual(ok.status, 303);
        assert.ok(/n=context_published/.test(ok.headers.get('location')));
        const page = await t.get('/i/ACME');
        assert.ok(page.text.includes('Written by a Trade editor.'));
        assert.ok(page.text.includes('Acme filed nothing new this week.'));
        const stale = await t.get('/editor/i/ACME/context', { as: t.editor, form: { _csrf: t.csrf(t.editor), body: 'Late edit.', expected_revision: String(head) } });
        assert.ok(/newer revision/.test(errOf(stale)));
        assert.ok((await t.get('/i/ACME')).text.includes('Acme filed nothing new this week.'));
    });

    await check('retracting the context takes the page out of the sitemap and sends a Search tombstone', async () => {
        const r = await t.get('/editor/i/ACME/context/retract', { as: t.editor, form: { _csrf: t.csrf(t.editor) } });
        assert.strictEqual(r.status, 303);
        assert.ok(!(await t.get('/sitemaps/instruments.xml')).text.includes('/i/ACME'));
        assert.strictEqual(t.events('trade.index_document.deleted').length, 1);
    });

    await check('the editor is for editors only; its pages are private and noindex', async () => {
        assert.strictEqual((await t.get('/editor', { as: t.alice })).status, 403);
        assert.strictEqual((await t.get('/editor')).status, 303);
        const e = await t.get('/editor', { as: t.editor });
        assert.strictEqual(e.status, 200);
        assert.ok(/private/.test(e.headers.get('cache-control')));
        assert.strictEqual(e.headers.get('x-robots-tag'), 'noindex, nofollow');
        const add = await t.get('/editor/instruments', { as: t.editor, form: { _csrf: t.csrf(t.editor), symbol: 'nwco', name: 'New Co', kind: 'equity', cik: '' } });
        assert.strictEqual(add.status, 303);
        assert.ok(t.ctx.instruments.bySymbol('NWCO'));
    });

    await t.close();
    done();
})();
