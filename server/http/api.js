'use strict';

/**
 * /api/v1 — JSON for services (Network client-credentials tokens, audience openvibe.trade, one
 * capability per route; private data needs X-OV-Subject, the person the service acts for) and for
 * browsers or apps with a Network user JWT (judged by ownership / the editor list). Errors are
 * problem+json. Every response is private, no-store and noindex.
 *
 * Public reads (no capability; services need none either):
 *   GET    /instruments?limit&offset                       active instruments
 *   GET    /instruments/:symbol                            the instrument page's data (as /i/:symbol.json)
 *   GET    /instruments/:symbol/observations?metric&before&limit   history, each with freshness
 *   GET    /instruments/:symbol/documents?limit&offset
 *   GET    /sources                                        freshness of every source
 * Capabilities:
 *   GET    /instruments/resolve?q=&kind=                   trade.instrument.resolve
 *   POST   /instruments                                    trade.instrument.manage   (editors)
 *   PATCH  /instruments/:symbol                            trade.instrument.manage   (editors)
 *   POST   /instruments/:symbol/aliases                    trade.instrument.manage   (editors)
 *   POST   /observations                                   trade.observation.write   (services only)
 *   GET    /instruments/:symbol/context                    trade.context.read        (published; ?all=1 drafts for editors/services)
 *   GET    /instruments/:symbol/context/input              trade.context.read        (OpenVibe.AI workflow input)
 *   POST   /instruments/:symbol/context                    trade.context.propose     (AI drafts with X-OV-Origin: ai; editors)
 *   POST   /instruments/:symbol/context/revisions/:n/review   people on the editor list only
 *   GET    /watchlists                                     trade.watchlist.read
 *   POST   /watchlists                                     trade.watchlist.create
 *   GET    /watchlists/:id                                 trade.watchlist.read
 *   PATCH  /watchlists/:id                                 trade.watchlist.update
 *   PUT    /watchlists/:id/items/:symbol                   trade.watchlist.update
 *   DELETE /watchlists/:id/items/:symbol                   trade.watchlist.update
 *   DELETE /watchlists/:id                                 trade.watchlist.delete
 *   GET    /alerts                                         trade.alert.read
 *   GET    /alerts/deliveries                              trade.alert.read
 *   POST   /alerts                                         trade.alert.create
 *   DELETE /alerts/:id                                     trade.alert.delete
 *
 * There is no endpoint that takes an order, holds or moves value, or gives personal advice
 * (ADR-025); test/route-inventory.test.js fails the build if one appears.
 */
const express = require('express');
const contracts = require('openvibe-contracts');
const { run, jsonBody, ApiError, privateNoStore } = require('./errors');
const { guard } = require('../auth/viewer');
const { CAPABILITIES: C } = require('../auth/capabilities');
const { define } = require('./routes');
const { DISCLAIMER } = require('../domain/alerts');

function cors(origins) {
    const allowed = new Set(origins);
    return function apiCors(req, res, next) {
        const origin = req.get('origin');
        if (origin && allowed.has(origin)) {
            res.set('Access-Control-Allow-Origin', origin);
            res.vary('Origin');
            res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, traceparent, X-OpenVibe-Request-Id');
            res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE');
            res.set('Access-Control-Expose-Headers', 'X-OpenVibe-Request-Id');
            res.set('Access-Control-Max-Age', '600');
        }
        if (req.method === 'OPTIONS') return res.status(204).end();
        next();
    };
}

function createApi(ctx) {
    const { config, instruments, observations, documents, freshness, context, watchlists, alerts, reading, viewers, indexing, store } = ctx;
    const router = express.Router();
    router.use(cors(config.apiCorsOrigins));
    router.use(viewers.middleware());
    router.use(function privateApi(req, res, next) { privateNoStore(res); res.set('X-Robots-Tag', 'noindex'); next(); });

    const tp = (req) => ({ traceparent: req.ov && req.ov.traceparent });

    function mustInstrument(req) {
        const i = instruments.bySymbol(req.params.symbol);
        if (!i) throw new ApiError(404, 'instrument.not_found', 'No such instrument');
        return i;
    }

    /** The person whose private data this is: the signed-in user, or X-OV-Subject for a service. */
    function owner(req) {
        const v = req.viewer;
        if ((v.kind === 'user' || v.kind === 'service') && v.subject) return v.subject;
        if (v.kind === 'service') throw new ApiError(400, 'subject.required', 'X-OV-Subject names the person this service acts for');
        throw new ApiError(401, 'auth.required', 'Sign in with OpenVibe');
    }

    function mustEditor(req) {
        const v = req.viewer;
        if (v.kind === 'service') return;   // the capability guard already decided
        if (v.kind !== 'user' || !v.editor) throw new ApiError(403, 'editor.forbidden', 'Only Trade editors can do this');
    }

    const paging = (req, def = 50, max = 200) => ({
        limit: Math.min(Math.max(parseInt(req.query.limit, 10) || def, 1), max),
        offset: Math.max(parseInt(req.query.offset, 10) || 0, 0),
    });

    // ── Instruments ─────────────────────────────────────────

    define(router, 'get', '/instruments', 'getInstruments', run((req) => {
        const { limit, offset } = paging(req);
        const page = instruments.page({ limit, offset });
        return { total: page.total, instruments: page.instruments.map(reading.instrumentDto), disclaimer: DISCLAIMER };
    }));

    define(router, 'get', '/instruments/resolve', 'resolveInstrument', guard(C.INSTRUMENT_RESOLVE), run((req) => {
        const r = instruments.resolve(req.query.q, { kind: req.query.kind || null });
        return {
            query: r.query, status: r.status, match: r.match,
            instrument: r.instrument ? reading.instrumentDto(r.instrument) : null,
            candidates: r.candidates.map(reading.instrumentDto),
        };
    }));

    define(router, 'post', '/instruments', 'createInstrument', guard(C.INSTRUMENT_MANAGE), jsonBody, run((req) => {
        mustEditor(req);
        const by = req.viewer.kind === 'service' ? req.viewer.service : req.viewer.subject;
        const i = instruments.create(req.body || {}, by);
        store.tx(() => indexing.refresh(i, tp(req)));
        return { instrument: reading.instrumentDto(i), aliases: instruments.aliases(i) };
    }, 201));

    define(router, 'get', '/instruments/:symbol', 'getInstrument', run((req) => {
        const { decision, ...data } = reading.instrument(mustInstrument(req), paging(req, 25, 100));
        return data;
    }));

    define(router, 'patch', '/instruments/:symbol', 'updateInstrument', guard(C.INSTRUMENT_MANAGE), jsonBody, run((req) => {
        mustEditor(req);
        const i = instruments.update(mustInstrument(req), req.body || {});
        store.tx(() => indexing.refresh(i, tp(req)));
        return { instrument: reading.instrumentDto(i) };
    }));

    define(router, 'post', '/instruments/:symbol/aliases', 'addInstrumentAlias', guard(C.INSTRUMENT_MANAGE), jsonBody, run((req) => {
        mustEditor(req);
        const i = mustInstrument(req);
        const b = req.body || {};
        const alias = instruments.addAlias(i, String(b.kind || ''), b.value, req.viewer.kind === 'service' ? req.viewer.service : req.viewer.subject);
        return { alias, aliases: instruments.aliases(i) };
    }, 201));

    define(router, 'get', '/instruments/:symbol/observations', 'getObservations', run((req) => {
        const i = mustInstrument(req);
        const list = observations.history(i, { metric: req.query.metric || null, before: req.query.before || null, limit: req.query.limit });
        return { instrument: reading.instrumentDto(i), observations: list.map((o) => observations.dto(o)), disclaimer: DISCLAIMER };
    }));

    define(router, 'get', '/instruments/:symbol/documents', 'getDocuments', run((req) => {
        const i = mustInstrument(req);
        return { instrument: reading.instrumentDto(i), total: documents.count(i), documents: documents.forInstrument(i, paging(req)).map(documents.dto) };
    }));

    // ── Observations (first-party feeds) ────────────────────

    define(router, 'post', '/observations', 'recordObservation', guard(C.OBSERVATION_WRITE), jsonBody, run((req) => {
        if (req.viewer.kind !== 'service') throw new ApiError(403, 'observation.services_only', 'Observations come from sources, recorded by a service with trade.observation.write');
        const b = req.body || {};
        const instrument = b.instrument_id ? instruments.get(String(b.instrument_id)) : instruments.bySymbol(b.symbol);
        if (!instrument) throw new ApiError(404, 'instrument.not_found', 'No such instrument (symbol or instrument_id)');
        const out = observations.record(b, instrument, { recordedBy: req.viewer.service, ...tp(req) });
        ctx.outbox.kick();
        return { observation: observations.dto(out.observation), created: out.created };
    }, (out) => (out.created ? 201 : 200)));

    // ── Context ─────────────────────────────────────────────

    define(router, 'get', '/instruments/:symbol/context', 'getContext', guard(C.CONTEXT_READ), run((req) => {
        const i = mustInstrument(req);
        const out = { instrument: reading.instrumentDto(i), published: context.published(i), disclaimer: DISCLAIMER };
        if (req.query.all === '1') {
            const v = req.viewer;
            if (!(v.kind === 'service' || (v.kind === 'user' && v.editor))) throw new ApiError(403, 'editor.forbidden', 'Only Trade editors see drafts');
            out.pending = context.pending(i);
        }
        return out;
    }));

    define(router, 'get', '/instruments/:symbol/context/input', 'getContextInput', guard(C.CONTEXT_READ), run((req) => context.input(mustInstrument(req))));

    define(router, 'post', '/instruments/:symbol/context', 'proposeContext', guard(C.CONTEXT_PROPOSE), jsonBody, run((req) => {
        const i = mustInstrument(req);
        const out = context.propose(req.viewer, i, req.body || {});
        ctx.outbox.kick();
        return { revision: context.view(ctx.instruments.get(i.id), out.revision), published: out.published };
    }, 201));

    define(router, 'post', '/instruments/:symbol/context/revisions/:n/review', 'reviewContext', jsonBody, run((req) => {
        const i = mustInstrument(req);
        const b = req.body || {};
        const out = context.review(req.viewer, i, parseInt(req.params.n, 10), { decision: b.decision, note: b.note });
        ctx.outbox.kick();
        return out;
    }, 201));

    // ── Sources ─────────────────────────────────────────────

    define(router, 'get', '/sources', 'getSourceFreshness', run(() => ({ sources: freshness.all(), sync: ctx.sync.state() })));

    // ── Watchlists (private) ────────────────────────────────

    define(router, 'get', '/watchlists', 'getWatchlists', guard(C.WATCHLIST_READ), run((req) => ({ watchlists: watchlists.forOwner(owner(req)).map((w) => watchlists.dto(w)) })));

    define(router, 'post', '/watchlists', 'createWatchlist', guard(C.WATCHLIST_CREATE), jsonBody, run((req) => ({ watchlist: watchlists.dto(watchlists.create(owner(req), req.body || {})) }), 201));

    define(router, 'get', '/watchlists/:id', 'getWatchlist', guard(C.WATCHLIST_READ), run((req) => ({ watchlist: watchlists.dto(watchlists.mustOwn(owner(req), req.params.id)) })));

    define(router, 'patch', '/watchlists/:id', 'renameWatchlist', guard(C.WATCHLIST_UPDATE), jsonBody, run((req) => {
        const w = watchlists.mustOwn(owner(req), req.params.id);
        return { watchlist: watchlists.dto(watchlists.rename(w, req.body || {})) };
    }));

    define(router, 'put', '/watchlists/:id/items/:symbol', 'addWatchlistItem', guard(C.WATCHLIST_UPDATE), jsonBody, run((req) => {
        const w = watchlists.mustOwn(owner(req), req.params.id);
        const added = watchlists.add(w, instruments.bySymbol(req.params.symbol), (req.body || {}).note);
        return { added, watchlist: watchlists.dto(w) };
    }));

    define(router, 'delete', '/watchlists/:id/items/:symbol', 'removeWatchlistItem', guard(C.WATCHLIST_UPDATE), run((req) => {
        const w = watchlists.mustOwn(owner(req), req.params.id);
        return { removed: watchlists.drop(w, instruments.bySymbol(req.params.symbol)), watchlist: watchlists.dto(w) };
    }));

    define(router, 'delete', '/watchlists/:id', 'deleteWatchlist', guard(C.WATCHLIST_DELETE), run((req) => ({ deleted: watchlists.remove(watchlists.mustOwn(owner(req), req.params.id)) })));

    // ── Alerts (private) ────────────────────────────────────

    define(router, 'get', '/alerts', 'getAlertRules', guard(C.ALERT_READ), run((req) => ({ rules: alerts.forOwner(owner(req)) })));

    define(router, 'get', '/alerts/deliveries', 'getAlertDeliveries', guard(C.ALERT_READ), run((req) => ({ deliveries: alerts.deliveries(owner(req), req.query.limit) })));

    define(router, 'post', '/alerts', 'createAlertRule', guard(C.ALERT_CREATE), jsonBody, run((req) => {
        const b = req.body || {};
        const rule = alerts.create(owner(req), instruments.bySymbol(b.symbol), b);
        return { rule: alerts.dto(rule) };
    }, 201));

    define(router, 'delete', '/alerts/:id', 'deleteAlertRule', guard(C.ALERT_DELETE), run((req) => ({ deleted: alerts.remove(owner(req), req.params.id) })));

    router.use(function apiNotFound(req, res) { contracts.http.sendProblem(res, 404, 'route.not_found', { detail: 'Not found', ctx: req.ov }); });
    return router;
}

module.exports = { createApi };
