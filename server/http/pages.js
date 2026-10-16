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
const showcase = require('openvibe-shared/showcase');
const frame = require('openvibe-shared/frame');
const seo = require('openvibe-publishing/seo');
const cache = require('openvibe-shared/cache-policy');
const rateLimit = require('express-rate-limit');
const { ApiError } = require('./errors');
const { paginate } = require('openvibe-publishing/ssr');
const views = require('../render/views');
const { SITE_SUMMARY } = require('../render/layout');
const { define } = require('./routes');

function createPages(ctx) {
    const { config, instruments, documents, reading, freshness, urls, watchlists, context, common, sync, observations } = ctx;
    const router = express.Router();
    const listing = (path) => seo.evaluate({ state: 'published', visibility: 'public', canonicalUrl: urls.abs(path), wordCount: 0 }, { policy: { minWords: 0 } });

    // What shipped on OpenVibe.Trade: the shared update log every OpenVibe site has.
    define(router, 'get', '/updates', 'showUpdates', (req, res) => common.page(req, res, {
        title: 'What shipped on OpenVibe.Trade', canonical: urls.abs('/updates'), decision: listing('/updates'),
        body: frame.updatesBody({ service: 'trade', siteName: 'OpenVibe.Trade' }) + `<script src="${ovServe.url('shipped.js')}" defer></script>`,
    }));
    define(router, 'get', '/', 'showHome', async (req, res) => {
        const pageNo = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const per = 50;
        const first = await instruments.page({ limit: 0, offset: 0 });
        const pager = paginate({ page: pageNo, perPage: per, total: first.total, href: (p) => (p === 1 ? '/' : `/?page=${p}`) });
        if (pager.outOfRange && first.total) return common.notFound(req, res);
        const page = await instruments.page({ limit: pager.limit, offset: pager.offset });
        // Each listed instrument's headline number on the list itself: its latest price, close or rate (else its first
        // metric), with when it was observed and whether its source is current. Fifty at most per page.
        const now = Date.now();
        const latest = new Map(await Promise.all(page.instruments.map(async (i) => {
            const rows = await observations.latest(i);
            const pick = ['price', 'close', 'rate'].map((m) => rows.find((o) => o.metric === m)).find(Boolean) || rows[0];
            return [i.id, pick ? await observations.dto(pick, { now }) : null];
        })));
        // Without a headline number, the newest filing stands in on the list.
        const latestDocs = new Map((await Promise.all(page.instruments.filter((i) => !latest.get(i.id)).map(async (i) => {
            const [d] = await documents.forInstrument(i, { limit: 1 });
            return d ? [i.id, documents.dto(d)] : null;
        }))).filter(Boolean));
        const recent = (await Promise.all((await documents.recent(10)).map(async (d) => ({ document: documents.dto(d), instrument: await instruments.get(d.instrument_id) }))));
        const canonical = urls.abs(pageNo === 1 ? '/' : `/?page=${pageNo}`);
        common.page(req, res, {
            title: null, canonical, decision: listing(pageNo === 1 ? '/' : `/?page=${pageNo}`),
            // The home page carries the site's ai-summary meta and WebPage JSON-LD (v1.3.0 forwards it).
            summary: pageNo === 1 ? SITE_SUMMARY : null,
            styles: pageNo === 1 ? [showcase.STYLESHEET] : [],
            feeds: [{ type: 'rss', href: '/feed.xml', title: 'Recent documents (RSS)' }, { type: 'atom', href: '/atom.xml', title: 'Recent documents (Atom)' }, { type: 'json', href: '/feed.json', title: 'Recent documents (JSON Feed)' }],
            jsonLd: [seo.compact({ '@context': 'https://schema.org', '@type': 'WebSite', url: urls.abs('/'), name: 'OpenVibe.Trade', inLanguage: 'en' })],
            body: views.home({ page, recent, urls, sync: await sync.state(), pager, latest, latestDocs, briefs: pageNo === 1 ? await ctx.briefs.recent(6) : [] }),
        });
    });

    define(router, 'get', '/resolve', 'showResolve', async (req, res) => {
        const result = await instruments.resolve(req.query.q);
        if (result.status === 'resolved') {
            common.vary(res);
            res.set('Cache-Control', cache.htmlHeaders({ maxAge: 60 }));
            return res.redirect(302, urls.path.instrument(result.instrument));
        }
        common.page(req, res, { status: result.status === 'not_found' ? 404 : 200, title: 'Find an instrument', body: views.resolvePage({ result, urls }), personal: true });
    });

    define(router, 'get', '/sources', 'showSources', async (req, res) => {
        common.page(req, res, {
            title: 'Source freshness', canonical: urls.abs('/sources'),
            body: views.sourcesPage({ sources: await freshness.all(), sync: await sync.state() }),
        });
    });

    define(router, 'get', '/i/:symbol', 'showInstrument', async (req, res) => {
        let raw = String(req.params.symbol);
        const asJson = raw.endsWith('.json');
        if (asJson) raw = raw.slice(0, -5);
        let instrument = await instruments.bySymbol(raw);
        if (!instrument) {
            const r = await instruments.resolve(raw, { kind: 'ticker' });
            instrument = r.status === 'resolved' ? r.instrument : null;
        }
        if (!instrument) return asJson ? res.status(404).set('Cache-Control', cache.htmlHeaders({ private: true })).json({ code: 'instrument.not_found', error: 'No such instrument' }) : common.notFound(req, res, `No instrument has the symbol “${raw}”.`);
        if (instrument.symbol !== raw) {
            common.vary(res);
            res.set('Cache-Control', cache.htmlHeaders({ maxAge: 300 }));
            return res.redirect(301, asJson ? urls.path.instrumentJson(instrument) : urls.path.instrument(instrument) + (req.query.page ? `?page=${encodeURIComponent(req.query.page)}` : ''));
        }

        const pageNo = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const total = await documents.count(instrument);
        const pager = paginate({ page: pageNo, perPage: 25, total, href: (p) => (p === 1 ? urls.path.instrument(instrument) : `${urls.path.instrument(instrument)}?page=${p}`) });
        if (pager.outOfRange && total) return common.notFound(req, res);
        const data = await reading.instrument(instrument, { limit: pager.limit, offset: pager.offset });
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
                context: data.context, pending: viewer.editor ? await context.pending(instrument) : [],
                brief: await ctx.briefs.latest(instrument),
                briefs: { canAsk: ctx.briefs.enabled && Boolean(instrument.cik || data.observations.length || total) },
                viewer, watchlists: signedIn ? await watchlists.forOwner(viewer.subject) : [], csrf: common.csrf(req), loginHref: common.loginHref(req),
            }),
        });
    });

    // A reader asks for the AI brief (domain/briefs.js): a form post from Trade's own page only, five per address in ten
    // minutes, within the site's hourly budget. SEC's numbers are read first when this company's never were.
    const briefLimit = rateLimit({ windowMs: 10 * 60_000, max: 5, standardHeaders: true, legacyHeaders: false });
    define(router, 'post', '/i/:symbol/brief', 'writeBrief', briefLimit, async (req, res) => {
        const instrument = await instruments.bySymbol(req.params.symbol);
        if (!instrument) return common.notFound(req, res);
        const own = new URL(config.baseUrl).origin;
        const origin = req.get('origin');
        const fromHere = origin ? origin === own : String(req.get('referer') || '').startsWith(`${own}/`);
        try {
            if (!fromHere) throw new ApiError(403, 'brief.cross_site', 'Ask for a brief from the company\'s page on openvibe.trade');
            if (instrument.cik && ctx.sec.enabled && !(await ctx.facts.state(instrument))) await ctx.facts.record(instrument);
            const r = await ctx.briefs.make(instrument, { trigger: 'reader' });
            res.set('Cache-Control', cache.htmlHeaders({ private: true }));
            return res.redirect(303, `${urls.path.instrument(instrument)}?n=${r.created ? 'brief_made' : 'brief_current'}#ai-brief`);
        } catch (err) {
            return common.failure(req, res, err);
        }
    });

    return router;
}

module.exports = { createPages };
