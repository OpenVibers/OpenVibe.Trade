'use strict';

/**
 * Crawl, feed and machine-readability artifacts (roadmap §32.4/§32.5):
 *
 *   GET /robots.txt                        sitemap + explicit automated-consumer policy
 *   GET /llms.txt                          orientation for language models
 *   GET /llms-full.txt                     the same map, with a short summary of every indexable
 *                                          instrument (never the source's full text)
 *   GET /sitemap.xml                       sitemap index
 *   GET /sitemaps/pages.xml                the front page, /instruments and /filings
 *   GET /sitemaps/instruments.xml          INDEXABLE instrument pages only (the gate decides:
 *                                          person-reviewed context, no stale price); lastmod = the
 *                                          latest instrument, observation or document change
 *   GET /feed.xml | /atom.xml | /feed.json recent public documents across instruments
 *   GET /i/:symbol/documents.xml|.atom|.json  one instrument's documents
 *
 * Built from the database on every request, never from the viewer. Watchlists, alert rules,
 * deliveries and the editor never appear in any of them.
 */
const express = require('express');
const seo = require('openvibe-publishing/seo');
const sharedSeo = require('openvibe-shared/seo');
const cache = require('openvibe-shared/cache-policy');
const { define } = require('./routes');
const { DISCLAIMER, SITE_NAME, SITE_SUMMARY } = require('../render/layout');

function createDiscovery(ctx) {
    const { config, store, instruments, documents, indexing, context, urls, common } = ctx;
    const router = express.Router();
    const abs = urls.abs;
    const xml = (res, body, type = 'application/xml') => res.type(type).set('Cache-Control', cache.htmlHeaders({ maxAge: 300 })).send(body);
    const listing = (url) => seo.evaluate({ state: 'published', visibility: 'public', canonicalUrl: url, wordCount: 0 }, { policy: { minWords: 0 } });

    function feedItem(d, instrument) {
        const url = urls.documentAnchor(instrument, d);
        const when = (ms) => (ms == null ? 'no date stated' : new Date(ms).toISOString());
        return {
            id: `urn:openvibe:trade:document:${d.id}`,
            url,
            title: `${instrument.symbol}: ${d.form_type ? `${d.form_type} — ` : ''}${d.title || d.filer_name || 'document'}`,
            summary: `${d.kind === 'filing' ? 'Filed' : 'Published'} ${when(d.published_at)}; retrieved ${when(d.retrieved_at)} from source ${d.source_key}.${d.url ? ` Original: ${d.url}` : ''} ${DISCLAIMER}`,
            published: d.published_at == null ? null : new Date(d.published_at).toISOString(),
            tags: [instrument.symbol, ...(d.form_type ? [d.form_type] : [])],
            decision: listing(url),
        };
    }

    function sendFeed(res, type, channel, items) {
        if (type === 'json') {
            return res.type('application/feed+json').set('Cache-Control', cache.htmlHeaders({ maxAge: 300 })).send(JSON.stringify(seo.jsonFeed(channel, items)));
        }
        if (type === 'atom') {
            const newest = items.map((i) => i.published).filter(Boolean).sort().pop();
            return xml(res, seo.atomFeed({ ...channel, ...(newest ? {} : { updated: new Date(store.now()).toISOString() }) }, items), 'application/atom+xml');
        }
        return xml(res, seo.rssFeed(channel, items), 'application/rss+xml');
    }

    define(router, 'get', '/robots.txt', 'robotsTxt', (_req, res) => {
        const body = [
            '# openvibe.trade automated-consumer policy: search engines and AI crawlers are welcome to read',
            '# instrument pages, feeds and sitemaps. Watchlists, alerts, the editor, sign-in and the API are',
            '# private or not for crawling. Pages decide their own indexability (meta robots / X-Robots-Tag).',
            '# Information only: nothing here is investment advice, and there is no trading here.',
            sharedSeo.robotsTxt({ sitemaps: [abs('/sitemap.xml')], disallow: ['/watchlists', '/alerts', '/editor', '/resolve', '/auth/', '/api/', '/internal/'] }),
        ].join('\n');
        res.type('text/plain').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 })).send(body);
    });

    define(router, 'get', '/llms.txt', 'llmsTxt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 })).send(sharedSeo.llmsTxt({
            name: SITE_NAME,
            summary: SITE_SUMMARY,
            details: 'Every number on an instrument page is an observation with observed_at, retrieved_at and its source; an instrument without observations shows no number. Stale sources are labelled "stale since <time>" and never replaced. Each instrument page has a JSON twin at /i/<SYMBOL>.json with the same data. AI briefs (OpenVibe.AI) are written only from the SEC numbers and filings on the page, cite each one, are labelled as AI-written and not reviewed by a person, and never give advice; editor context drafted by AI is not published before a person reviews it. There is no custody, order execution, escrow, marketplace or personal advice.',
            sections: [
                { title: 'Start here', links: [
                    { title: 'Front page', url: abs('/'), note: 'AI briefs, euro reference rates, new annual and quarterly reports, filings by form, newest filings' },
                    { title: 'Companies and currencies', url: abs('/instruments'), note: 'all instruments, the newest filing or figure first' },
                    { title: 'Filings', url: abs('/filings'), note: 'the newest SEC filings; /filings?form=10-K for one form type' },
                    { title: 'Source freshness', url: abs('/sources') },
                    { title: 'Sitemap', url: abs('/sitemap.xml') },
                ] },
                { title: 'Feeds', links: [
                    { title: 'Recent documents (RSS)', url: abs('/feed.xml') }, { title: 'Atom', url: abs('/atom.xml') }, { title: 'JSON Feed', url: abs('/feed.json') },
                    { title: 'Per instrument', url: abs('/'), note: '/i/<SYMBOL>/documents.xml, .atom and .json' },
                ] },
                { title: 'Data', links: [{ title: 'Instrument JSON', url: abs('/'), note: 'append .json to an instrument URL (/i/<SYMBOL>.json)' }] },
            ],
        }));
    });

    // The full-text AI map: the llms.txt header, then a short summary of every indexable instrument
    // page — the same gate the sitemap uses. The summary is the reviewed context, clipped; the
    // source's own full text is never reproduced (llms.txt states the rule).
    define(router, 'get', '/llms-full.txt', 'llmsFullTxt', async (_req, res) => {
        const active = await instruments.indexCandidates();
        const decisions = await Promise.all(active.map(async (i) => await indexing.decide(i)));
        const pages = await Promise.all(active.filter((_i, n) => decisions[n].indexable).map(async (i) => {
            const rev = await context.published(i);
            return { title: `${i.symbol} — ${i.name}`, url: urls.instrument(i), text: rev ? String(rev.text || '').replace(/\s+/g, ' ').trim().slice(0, 300) : '' };
        }));
        res.type('text/plain').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 })).send(sharedSeo.llmsFull({
            site: SITE_NAME, summary: SITE_SUMMARY, base: config.baseUrl, maxBytes: 512 * 1024,
            sections: [{ title: 'Instruments', pages }],
        }));
    });

    async function pageChanges() {
        const rows = await store.db.prepare(`SELECT instrument_id, MAX(changed_at) AS changed_at FROM (
            SELECT instrument_id, recorded_at AS changed_at FROM trade_market_observations
            UNION ALL SELECT instrument_id, updated_at AS changed_at FROM trade_source_documents
        ) changes GROUP BY instrument_id`).all();
        return new Map(rows.map((r) => [r.instrument_id, r.changed_at]));
    }
    const pageLastmod = (instrument, changes) => Math.max(instrument.updated_at || 0, instrument.context_published_at || 0, changes.get(instrument.id) || 0);

    define(router, 'get', '/sitemap.xml', 'sitemapIndex', async (_req, res) => {
        const active = await instruments.indexCandidates();
        const decisions = await Promise.all(active.map(async (i) => await indexing.decide(i)));
        const changes = await pageChanges();
        const times = active.filter((i, n) => decisions[n].indexable).map((i) => pageLastmod(i, changes)).filter(Boolean);
        const newest = times.length ? new Date(Math.max(...times)).toISOString() : null;
        const pagesNewest = (await documents.recent(1))[0];
        xml(res, seo.sitemapIndex([
            { loc: abs('/sitemaps/pages.xml'), ...(pagesNewest ? { lastmod: new Date(Math.max(pagesNewest.first_seen_at, pagesNewest.published_at || 0)).toISOString() } : {}) },
            { loc: abs('/sitemaps/instruments.xml'), ...(newest ? { lastmod: newest } : {}) },
        ]));
    });

    // The pages a person browses: the front page, every company and currency, the filings. Their lastmod is the newest
    // filing's (they list it). /sources is noindex (it is a freshness table a crawler has no use for), so it is kept
    // out of the sitemap: a sitemap must not list a page that says noindex.
    define(router, 'get', '/sitemaps/pages.xml', 'pagesSitemap', async (_req, res) => {
        const newest = (await documents.recent(1))[0];
        const lastmod = newest ? Math.max(newest.first_seen_at, newest.published_at || 0) : null;
        const decide = (path) => seo.evaluate({ state: 'published', visibility: 'public', canonicalUrl: abs(path), wordCount: 0 }, { policy: { minWords: 0 } });
        xml(res, seo.sitemap(['/', '/instruments', '/filings'].map((path) => ({ loc: abs(path), lastmod, decision: decide(path) }))).files[0]);
    });

    define(router, 'get', '/sitemaps/instruments.xml', 'instrumentSitemap', async (_req, res) => {
        const changes = await pageChanges();
        // Without a published context an instrument page is noindex (indexing.js), so only the candidates are weighed.
        const entries = (await Promise.all((await instruments.indexCandidates()).map(async (i) => ({
            loc: urls.instrument(i),
            ...(pageLastmod(i, changes) ? { lastmod: new Date(pageLastmod(i, changes)).toISOString() } : {}),
            decision: await indexing.decide(i),
        }))));
        xml(res, seo.sitemap(entries).files[0]);
    });

    const siteChannel = (type) => ({
        title: 'Recent documents — OpenVibe.Trade',
        link: abs('/'),
        feedUrl: abs(type === 'atom' ? '/atom.xml' : type === 'json' ? '/feed.json' : '/feed.xml'),
        description: `Filings and documents recorded from OpenVibe.Sources, with their source dates. ${DISCLAIMER}`,
        language: 'en',
    });
    const recentItems = async () => (await Promise.all((await documents.recent(50)).map(async (d) => feedItem(d, await instruments.get(d.instrument_id)))));
    define(router, 'get', '/feed.xml', 'documentsRss', async (_req, res) => sendFeed(res, 'rss', siteChannel('rss'), await recentItems()));
    define(router, 'get', '/atom.xml', 'documentsAtom', async (_req, res) => sendFeed(res, 'atom', siteChannel('atom'), await recentItems()));
    define(router, 'get', '/feed.json', 'documentsJsonFeed', async (_req, res) => sendFeed(res, 'json', siteChannel('json'), await recentItems()));

    define(router, 'get', '/i/:symbol/documents.:format', 'instrumentDocumentsFeed', async (req, res) => {
        const type = { xml: 'rss', atom: 'atom', json: 'json' }[req.params.format];
        const instrument = await instruments.bySymbol(req.params.symbol);
        if (!type || !instrument || instrument.status !== 'active') return common.notFound(req, res);
        if (instrument.symbol !== req.params.symbol) return res.redirect(301, urls.path.documentsFeed(instrument, type));
        const items = (await documents.forInstrument(instrument, { limit: 50 })).map((d) => feedItem(d, instrument));
        sendFeed(res, type, {
            title: `${instrument.symbol} documents — OpenVibe.Trade`, link: urls.instrument(instrument),
            feedUrl: abs(urls.path.documentsFeed(instrument, type)),
            description: `Filings and documents about ${instrument.name}, with their source dates. ${DISCLAIMER}`, language: 'en',
        }, items);
    });

    return router;
}

module.exports = { createDiscovery };
