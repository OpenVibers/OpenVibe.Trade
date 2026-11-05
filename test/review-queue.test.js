'use strict';
/**
 * GET /api/v1/review-queue: a company page whose AI context draft waits for a person, editor-only,
 * with the review path that publishes it. Reviewing it clears the queue and makes the page indexable.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const WORDS = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

(async () => {
    const t = await boot();
    const acme = await t.instrument({ symbol: 'ACME', name: 'Acme Corp', cik: '1234567' });
    const { observation } = await t.observe(acme, { metric: 'price.close', value: '10.50', source_ref: 'a', observed_at: t.iso(t.T0 - 60e3), retrieved_at: t.iso(t.T0) });
    await t.ctx.freshness.report('test-feed', { status: 'healthy', lastSuccessAt: t.T0, staleAfterSec: 86400 });
    const ai = t.network.serviceToken('ai', ['trade.context.read', 'trade.context.propose']);
    try {
        await check('an AI context draft waits in the queue; a non-editor gets 403', async () => {
            const input = await t.get('/api/v1/instruments/ACME/context/input', { as: ai });
            const r = await t.get('/api/v1/instruments/ACME/context', {
                as: ai, headers: { 'x-ov-origin': 'ai' },
                json: {
                    workflow: { id: 'trade.summarize_market_context', run_id: 'run_01JABCDEFGHJKMNPQRSTVWXYZ0', version: 1 },
                    input_sources: input.json().input.sources.map((s) => ({ source_type: s.source_type, source_id: s.source_id })),
                    output: { summary: `The latest recorded close for ACME is 10.50 USD. ${WORDS(70)}`, observations: [{ text: 'Close of 10.50 USD', observed_at: t.iso(t.T0 - 60e3), citations: [0] }], stale_sources: [], disclaimer: 'Informational only; not investment advice.', citations: [0], gaps: [] },
                },
            });
            assert.strictEqual(r.status, 201, r.text);
            const q = await t.get('/api/v1/review-queue', { as: t.editor });
            assert.strictEqual(q.status, 200, q.text);
            const item = q.json().items.find((i) => i.id === acme.id);
            assert.ok(item, 'the AI draft is waiting');
            assert.deepStrictEqual([item.site, item.kind, item.revision], ['trade', 'company_page', 1]);
            assert.strictEqual(item.review.path, '/api/v1/instruments/ACME/context/revisions/1/review');
            assert.ok(item.reasons.some((x) => x.code === 'ai_generated_unreviewed' && /AI-written/.test(x.text)));
            const no = await t.get('/api/v1/review-queue', { as: t.alice });
            assert.strictEqual(no.status, 403);
            assert.strictEqual(no.json().code, 'editor.forbidden');
        });

        await check('approving through the context review publishes it, clears the queue and indexes the page', async () => {
            const r = await t.get('/api/v1/instruments/ACME/context/revisions/1/review', { as: t.editor, json: { decision: 'approved', note: 'Checked against the observation' } });
            assert.strictEqual(r.status, 201, r.text);
            assert.strictEqual(r.json().published, true);
            const q = await t.get('/api/v1/review-queue', { as: t.editor });
            assert.ok(!q.json().items.some((i) => i.id === acme.id), 'a reviewed context leaves the queue');
            const page = await t.get('/i/ACME');
            assert.ok(page.text.includes('<meta name="robots" content="index, follow">'), 'the company page is indexable');
            assert.ok(page.text.includes('reviewed by a person'));
            const audit = await t.ctx.store.db.prepare('SELECT * FROM trade_context_reviews WHERE entity_id = ?').all(acme.id);
            assert.strictEqual(audit.length, 1, 'the context review log is the audit');
        });
    } finally {
        await t.close();
        done();
    }
})().catch((e) => { console.error(e); process.exit(1); });
