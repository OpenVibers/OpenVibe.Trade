'use strict';

/**
 * The editor: plain HTML forms for people on the editor list (TRADE_EDITORS, Network admins).
 * Private, never cached by shared caches, never indexed.
 *
 *   GET  /editor                                     add instruments; context waiting for review
 *   POST /editor/instruments                         add an instrument
 *   GET  /editor/i/:symbol                           details, aliases, context revisions
 *   POST /editor/i/:symbol                           save details (name, kind, exchange, CIK, currency, status)
 *   POST /editor/i/:symbol/aliases                   add a ticker, CIK or name alias
 *   POST /editor/i/:symbol/context                   write a context revision (optionally publish)
 *   POST /editor/i/:symbol/context/:n/review         approve (publishes) or reject an AI draft
 *   POST /editor/i/:symbol/context/:n/publish        publish a revision that needs no review
 *   POST /editor/i/:symbol/context/retract          remove the published context from the page
 */
const express = require('express');
const seo = require('openvibe-publishing/seo');
const views = require('../render/views');
const { define } = require('./routes');
const { ApiError, asApiError } = require('./errors');

function createEditor(ctx) {
    const { instruments, context, documents, observations, common, indexing } = ctx;
    const router = express.Router();
    const decision = seo.evaluate({ state: 'published', visibility: 'private', canonicalUrl: null }, { policy: { minWords: 0 } });

    function requireEditor(req, res, next) {
        const v = req.viewer;
        if (v.kind !== 'user' || !v.subject) return common.after(res, `/auth/login?next=${encodeURIComponent(req.originalUrl)}`);
        if (!v.editor) return common.failure(req, res, new ApiError(403, 'editor.forbidden', 'Only people on the Trade editor list can use the editor.'));
        next();
    }
    const form = [...common.signedInForm, requireEditor];
    // Per-actor limits (http/actor-limits.js): each form names its budget, shared with the API route that
    // does the same thing, checked once the session, form token and editor list are.
    const B = (name) => ctx.limits.budget(name);

    async function mustInstrument(req) {
        const i = await instruments.bySymbol(req.params.symbol);
        if (!i) throw new ApiError(404, 'instrument.not_found', 'No such instrument');
        return i;
    }
    const editPath = (i) => `/editor/i/${encodeURIComponent(i.symbol)}`;

    function fail(req, res, path, err) {
        const e = asApiError(err);
        if (!e) throw err;
        common.after(res, path, { e: e.message });
    }

    define(router, 'get', '/editor', 'showEditor', requireEditor, async (req, res) => {
        const all = await instruments.active();
        const pending = [];
        for (const i of all) for (const p of await context.pending(i)) pending.push({ symbol: i.symbol, revision: p.revision, label: p.needs_review ? 'AI draft, needs review' : 'not published' });
        common.page(req, res, { title: 'Editor', decision, personal: true, body: views.editorHome({ instruments: all, pending, csrf: common.csrf(req), notice: common.noticeOf(req), kinds: instruments.KINDS }) });
    });

    define(router, 'post', '/editor/instruments', 'createInstrumentForm', ...form, B('trade.instrument.manage'), async (req, res) => {
        try {
            const i = await instruments.create(req.body, req.viewer.subject);
            await ctx.store.tx(async () => await indexing.refresh(i));
            common.after(res, editPath(i), { n: 'instrument_created' });
        } catch (err) { fail(req, res, '/editor', err); }
    });

    define(router, 'get', '/editor/i/:symbol', 'showEditorInstrument', requireEditor, async (req, res) => {
        let i;
        try { i = await mustInstrument(req); } catch (err) { return common.failure(req, res, err); }
        const revisions = (await Promise.all((await context.revisions(i, { limit: 30 })).map(async (r) => await context.view(i, r))));
        common.page(req, res, {
            title: `Editor · ${i.symbol}`, decision, personal: true,
            body: views.editorInstrument({
                instrument: i, aliases: await instruments.aliases(i), revisions, head: await context.head(i) ? (await context.head(i)).number : 0,
                documents: await documents.forInstrument(i, { limit: 30 }), observations: await observations.latest(i),
                csrf: common.csrf(req), notice: common.noticeOf(req), kinds: instruments.KINDS,
            }),
        });
    });

    define(router, 'post', '/editor/i/:symbol', 'saveInstrumentForm', ...form, B('trade.instrument.manage'), async (req, res) => {
        try {
            const i = await mustInstrument(req);
            const updated = await instruments.update(i, { name: req.body.name, kind: req.body.kind, exchange: req.body.exchange, cik: req.body.cik, currency: req.body.currency, status: req.body.status });
            await ctx.store.tx(async () => await indexing.refresh(updated));
            common.after(res, editPath(updated), { n: 'instrument_saved' });
        } catch (err) { fail(req, res, `/editor/i/${encodeURIComponent(req.params.symbol)}`, err); }
    });

    define(router, 'post', '/editor/i/:symbol/aliases', 'addAliasForm', ...form, B('trade.instrument.manage'), async (req, res) => {
        try {
            const i = await mustInstrument(req);
            await instruments.addAlias(i, String(req.body.kind || ''), req.body.value, req.viewer.subject);
            common.after(res, editPath(i), { n: 'alias_added' });
        } catch (err) { fail(req, res, `/editor/i/${encodeURIComponent(req.params.symbol)}`, err); }
    });

    define(router, 'post', '/editor/i/:symbol/context', 'writeContextForm', ...form, B('trade.context.propose'), async (req, res) => {
        try {
            const i = await mustInstrument(req);
            const raw = req.body.cite == null ? [] : Array.isArray(req.body.cite) ? req.body.cite : [req.body.cite];
            const cites = raw.map((s) => { const [kind, id] = String(s).split(':'); return { kind, id }; });
            const out = await context.propose(req.viewer, i, { body: req.body.body, cites, expected_revision: req.body.expected_revision, publish: req.body.publish === '1' });
            common.after(res, editPath(i), { n: out.published ? 'context_published' : 'context_saved' });
        } catch (err) {
            if (err && err.code === 'revision.conflict') return common.after(res, `/editor/i/${encodeURIComponent(req.params.symbol)}`, { e: 'Someone saved a newer revision while you were writing. Your text was not saved: copy it, reload and try again.' });
            fail(req, res, `/editor/i/${encodeURIComponent(req.params.symbol)}`, err);
        }
    });

    define(router, 'post', '/editor/i/:symbol/context/:n/review', 'reviewContextForm', ...form, B('trade.context.publish'), async (req, res) => {
        try {
            const i = await mustInstrument(req);
            const decisionValue = req.body.decision === 'approved' ? 'approved' : 'rejected';
            await context.review(req.viewer, i, parseInt(req.params.n, 10), { decision: decisionValue, note: req.body.note || null });
            common.after(res, editPath(i), { n: decisionValue === 'approved' ? 'context_published' : 'context_rejected' });
        } catch (err) { fail(req, res, `/editor/i/${encodeURIComponent(req.params.symbol)}`, err); }
    });

    define(router, 'post', '/editor/i/:symbol/context/:n/publish', 'publishContextForm', ...form, B('trade.context.publish'), async (req, res) => {
        try {
            const i = await mustInstrument(req);
            await context.publish(i, parseInt(req.params.n, 10));
            common.after(res, editPath(i), { n: 'context_published' });
        } catch (err) { fail(req, res, `/editor/i/${encodeURIComponent(req.params.symbol)}`, err); }
    });

    define(router, 'post', '/editor/i/:symbol/context/retract', 'retractContextForm', ...form, B('trade.context.publish'), async (req, res) => {
        try {
            const i = await mustInstrument(req);
            await context.retract(req.viewer, i);
            common.after(res, editPath(i), { n: 'context_retracted' });
        } catch (err) { fail(req, res, `/editor/i/${encodeURIComponent(req.params.symbol)}`, err); }
    });

    return router;
}

module.exports = { createEditor };
