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

    function mustInstrument(req) {
        const i = instruments.bySymbol(req.params.symbol);
        if (!i) throw new ApiError(404, 'instrument.not_found', 'No such instrument');
        return i;
    }
    const editPath = (i) => `/editor/i/${encodeURIComponent(i.symbol)}`;

    function fail(req, res, path, err) {
        const e = asApiError(err);
        if (!e) throw err;
        common.after(res, path, { e: e.message });
    }

    define(router, 'get', '/editor', 'showEditor', requireEditor, (req, res) => {
        const all = instruments.active();
        const pending = [];
        for (const i of all) for (const p of context.pending(i)) pending.push({ symbol: i.symbol, revision: p.revision, label: p.needs_review ? 'AI draft, needs review' : 'not published' });
        common.page(req, res, { title: 'Editor', decision, personal: true, body: views.editorHome({ instruments: all, pending, csrf: common.csrf(req), notice: common.noticeOf(req), kinds: instruments.KINDS }) });
    });

    define(router, 'post', '/editor/instruments', 'createInstrumentForm', ...form, (req, res) => {
        try {
            const i = instruments.create(req.body, req.viewer.subject);
            ctx.store.tx(() => indexing.refresh(i));
            common.after(res, editPath(i), { n: 'instrument_created' });
        } catch (err) { fail(req, res, '/editor', err); }
    });

    define(router, 'get', '/editor/i/:symbol', 'showEditorInstrument', requireEditor, (req, res) => {
        let i;
        try { i = mustInstrument(req); } catch (err) { return common.failure(req, res, err); }
        const revisions = context.revisions(i, { limit: 30 }).map((r) => context.view(i, r));
        common.page(req, res, {
            title: `Editor · ${i.symbol}`, decision, personal: true,
            body: views.editorInstrument({
                instrument: i, aliases: instruments.aliases(i), revisions, head: context.head(i) ? context.head(i).number : 0,
                documents: documents.forInstrument(i, { limit: 30 }), observations: observations.latest(i),
                csrf: common.csrf(req), notice: common.noticeOf(req), kinds: instruments.KINDS,
            }),
        });
    });

    define(router, 'post', '/editor/i/:symbol', 'saveInstrumentForm', ...form, (req, res) => {
        try {
            const i = mustInstrument(req);
            const updated = instruments.update(i, { name: req.body.name, kind: req.body.kind, exchange: req.body.exchange, cik: req.body.cik, currency: req.body.currency, status: req.body.status });
            ctx.store.tx(() => indexing.refresh(updated));
            common.after(res, editPath(updated), { n: 'instrument_saved' });
        } catch (err) { fail(req, res, `/editor/i/${encodeURIComponent(req.params.symbol)}`, err); }
    });

    define(router, 'post', '/editor/i/:symbol/aliases', 'addAliasForm', ...form, (req, res) => {
        try {
            const i = mustInstrument(req);
            instruments.addAlias(i, String(req.body.kind || ''), req.body.value, req.viewer.subject);
            common.after(res, editPath(i), { n: 'alias_added' });
        } catch (err) { fail(req, res, `/editor/i/${encodeURIComponent(req.params.symbol)}`, err); }
    });

    define(router, 'post', '/editor/i/:symbol/context', 'writeContextForm', ...form, (req, res) => {
        try {
            const i = mustInstrument(req);
            const raw = req.body.cite == null ? [] : Array.isArray(req.body.cite) ? req.body.cite : [req.body.cite];
            const cites = raw.map((s) => { const [kind, id] = String(s).split(':'); return { kind, id }; });
            const out = context.propose(req.viewer, i, { body: req.body.body, cites, expected_revision: req.body.expected_revision, publish: req.body.publish === '1' });
            common.after(res, editPath(i), { n: out.published ? 'context_published' : 'context_saved' });
        } catch (err) {
            if (err && err.code === 'revision.conflict') return common.after(res, `/editor/i/${encodeURIComponent(req.params.symbol)}`, { e: 'Someone saved a newer revision while you were writing. Your text was not saved: copy it, reload and try again.' });
            fail(req, res, `/editor/i/${encodeURIComponent(req.params.symbol)}`, err);
        }
    });

    define(router, 'post', '/editor/i/:symbol/context/:n/review', 'reviewContextForm', ...form, (req, res) => {
        try {
            const i = mustInstrument(req);
            const decisionValue = req.body.decision === 'approved' ? 'approved' : 'rejected';
            context.review(req.viewer, i, parseInt(req.params.n, 10), { decision: decisionValue, note: req.body.note || null });
            common.after(res, editPath(i), { n: decisionValue === 'approved' ? 'context_published' : 'context_rejected' });
        } catch (err) { fail(req, res, `/editor/i/${encodeURIComponent(req.params.symbol)}`, err); }
    });

    define(router, 'post', '/editor/i/:symbol/context/:n/publish', 'publishContextForm', ...form, (req, res) => {
        try {
            const i = mustInstrument(req);
            context.publish(i, parseInt(req.params.n, 10));
            common.after(res, editPath(i), { n: 'context_published' });
        } catch (err) { fail(req, res, `/editor/i/${encodeURIComponent(req.params.symbol)}`, err); }
    });

    define(router, 'post', '/editor/i/:symbol/context/retract', 'retractContextForm', ...form, (req, res) => {
        try {
            const i = mustInstrument(req);
            context.retract(req.viewer, i);
            common.after(res, editPath(i), { n: 'context_retracted' });
        } catch (err) { fail(req, res, `/editor/i/${encodeURIComponent(req.params.symbol)}`, err); }
    });

    return router;
}

module.exports = { createEditor };
