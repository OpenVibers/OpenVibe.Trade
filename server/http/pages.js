'use strict';

/**
 * Public pages, server-rendered and complete without JavaScript:
 *
 *   GET /                   instruments, recent documents, feeds
 *   GET /resolve?q=         deterministic resolution (CIK → ticker → exact name); one match → 302
 *   GET /i/:symbol          the instrument page: observations with timestamps and sources, context
 *                           with its disclosure, documents, source freshness ("stale since")
 *   GET /i/:symbol.json     the same data as JSON
 *   GET /sources            freshness of every source
 *
 * A lower-case symbol or a ticker alias answers 301 to the canonical /i/:SYMBOL.
 */
const express = require('express');
const ovServe = require('openvibe-shared/serve');
const frame = require('openvibe-shared/frame');
const seo = require('openvibe-publishing/seo');
const { paginate } = require('openvibe-publishing/ssr');
const views = require('../render/views');
const { define } = require('./routes');

function createPages(ctx) {
    const { config, instruments, documents, reading, freshness, urls, watchlists, context, common, sync } = ctx;
    const router = express.Router();
    const listing = (path) => seo.evaluate({ state: 'published', visibility: 'public', canonicalUrl: urls.abs(path), wordCount: 0 }, { policy: { minWords: 0 } });

    // What shipped on OpenVibe.Trade: the shared update log every OpenVibe site has.
    define(router, 'get', '/updates', 'showUpdates', (req, res) => common.page(req, res, {
        title: 'What shipped on OpenVibe.Trade', canonical: urls.abs('/updates'), decision: listing('/updates'),
        body: frame.updatesBody({ service: 'trade', siteName: 'OpenVibe.Trade' }) + `<script src="${ovServe.url('shipped.js')}" defer></script>`,
    }));
    define(router, 'get', '/', 'showHome', (req, res) => {
        const pageNo = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const per = 50;
        const first = instruments.page({ limit: 0, offset: 0 });
        const pager = paginate({ page: pageNo, perPage: per, total: first.total, href: (p) => (p === 1 ? '/' : `/?page=${p}`) });
        if (pager.outOfRange && first.total) return common.notFound(req, res);
        const page = instruments.page({ limit: pager.limit, offset: pager.offset });
        const recent = documents.recent(10).map((d) => ({ document: documents.dto(d), instrument: instruments.get(d.instrument_id) }));
        const canonical = urls.abs(pageNo === 1 ? '/' : `/?page=${pageNo}`);
        common.page(req, res, {
            title: null, canonical, decision: listing(pageNo === 1 ? '/' : `/?page=${pageNo}`),
            feeds: [{ type: 'rss', href: '/feed.xml', title: 'Recent documents (RSS)' }, { type: 'atom', href: '/atom.xml', title: 'Recent documents (Atom)' }, { type: 'json', href: '/feed.json', title: 'Recent documents (JSON Feed)' }],
            jsonLd: [seo.compact({ '@context': 'https://schema.org', '@type': 'WebSite', url: urls.abs('/'), name: 'OpenVibe.Trade', inLanguage: 'en' })],
            body: views.home({ page, recent, urls, sync: sync.state(), pager }),
        });
    });

    define(router, 'get', '/resolve', 'showResolve', (req, res) => {
        const result = instruments.resolve(req.query.q);
        if (result.status === 'resolved') {
            common.vary(res);
            res.set('Cache-Control', 'public, max-age=60');
            return res.redirect(302, urls.path.instrument(result.instrument));
        }
        common.page(req, res, { status: result.status === 'not_found' ? 404 : 200, title: 'Find an instrument', body: views.resolvePage({ result, urls }), personal: true });
    });

    define(router, 'get', '/sources', 'showSources', (req, res) => {
        common.page(req, res, {
            title: 'Source freshness', canonical: urls.abs('/sources'),
            body: views.sourcesPage({ sources: freshness.all(), sync: sync.state() }),
        });
    });

    define(router, 'get', '/i/:symbol', 'showInstrument', (req, res) => {
        let raw = String(req.params.symbol);
        const asJson = raw.endsWith('.json');
        if (asJson) raw = raw.slice(0, -5);
        let instrument = instruments.bySymbol(raw);
        if (!instrument) {
            const r = instruments.resolve(raw, { kind: 'ticker' });
            instrument = r.status === 'resolved' ? r.instrument : null;
        }
        if (!instrument) return asJson ? res.status(404).set('Cache-Control', 'private, no-store').json({ code: 'instrument.not_found', error: 'No such instrument' }) : common.notFound(req, res, `No instrument has the symbol “${raw}”.`);
        if (instrument.symbol !== raw) {
            common.vary(res);
            res.set('Cache-Control', 'public, max-age=300');
            return res.redirect(301, asJson ? urls.path.instrumentJson(instrument) : urls.path.instrument(instrument) + (req.query.page ? `?page=${encodeURIComponent(req.query.page)}` : ''));
        }

        const pageNo = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const total = documents.count(instrument);
        const pager = paginate({ page: pageNo, perPage: 25, total, href: (p) => (p === 1 ? urls.path.instrument(instrument) : `${urls.path.instrument(instrument)}?page=${p}`) });
        if (pager.outOfRange && total) return common.notFound(req, res);
        const data = reading.instrument(instrument, { limit: pager.limit, offset: pager.offset });
        const { decision } = data;

        if (asJson) {
            common.cacheFor(req, res);
            res.set('X-Robots-Tag', decision.robots);
            const { decision: _d, ...out } = data;
            return res.json(out);
        }
        const viewer = req.viewer;
        const signedIn = viewer.kind === 'user' && viewer.subject;
        common.page(req, res, {
            title: `${instrument.symbol} — ${instrument.name}`,
            description: `${instrument.name} (${instrument.symbol}): observations with their observation times and sources, filings and source freshness. Information only.`,
            canonical: urls.abs(pageNo === 1 ? urls.path.instrument(instrument) : `${urls.path.instrument(instrument)}?page=${pageNo}`),
            decision: pageNo === 1 ? decision : { ...decision, canonical: urls.instrument(instrument) },
            jsonLd: reading.jsonLd(instrument),
            feeds: ['rss', 'atom', 'json'].map((t) => ({ type: t, href: urls.path.documentsFeed(instrument, t), title: `${instrument.symbol} documents` })),
            personal: Boolean(signedIn),
            body: views.instrumentPage({
                ...data, instrument, urls, pager, notice: common.noticeOf(req),
                context: data.context, pending: viewer.editor ? context.pending(instrument) : [],
                viewer, watchlists: signedIn ? watchlists.forOwner(viewer.subject) : [], csrf: common.csrf(req), loginHref: common.loginHref(req),
            }),
        });
    });

    return router;
}

module.exports = { createPages };
