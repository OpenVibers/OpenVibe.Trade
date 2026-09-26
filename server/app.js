'use strict';

/**
 * OpenVibe.Trade — Express app factory. server/index.js listens and starts the worker; tests build
 * their own instance with a temp database, an injectable clock and mock neighbours.
 *
 *   Pages (http/pages.js)          /, /resolve, /i/:symbol(.json), /sources
 *   Private (http/private.js)      /watchlists, watchlist and alert forms
 *   Editor (http/editor.js)        /editor/…
 *   Discovery (http/discovery.js)  robots, llms, sitemaps, feeds
 *   API (http/api.js)              /api/v1/…
 *   Webhook (events/webhook.js)    POST /internal/events (signed OpenVibe.Events deliveries)
 *   Machine                        /api/health, /api/ready, /release.json, /metrics
 *
 * Information only (ADR-025): no route takes an order, holds value, runs escrow, lists goods
 * between users or gives personal advice. test/route-inventory.test.js enforces it.
 */
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const contracts = require('openvibe-contracts');

const configLib = require('./config');
const { openStore } = require('./db');
const { createAuthClient, createAuthRoutes } = require('./auth/sso');
const { createViewerResolver } = require('./auth/viewer');
const { createTradeOutbox } = require('./events/outbox');
const { createWebhook } = require('./events/webhook');
const { createUrls } = require('./domain/urls');
const { createInstruments } = require('./domain/instruments');
const { createFreshness } = require('./domain/freshness');
const { createObservations } = require('./domain/observations');
const { createDocuments } = require('./domain/documents');
const { createAlerts } = require('./domain/alerts');
const { createWatchlists } = require('./domain/watchlists');
const { createContext } = require('./domain/context');
const { createIndexing } = require('./domain/indexing');
const { createReading } = require('./domain/reading');
const { createSync } = require('./domain/sync');
const { createSourcesClient } = require('./clients/sources');
const { createCommon } = require('./http/common');
const { createPages } = require('./http/pages');
const { createPrivate } = require('./http/private');
const { createEditor } = require('./http/editor');
const { createDiscovery } = require('./http/discovery');
const { createApi } = require('./http/api');
const { define } = require('./http/routes');
const { createTradeReadiness } = require('./observability');
const { createWorker } = require('./worker');
const { assetVersion } = require('./render/layout');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VERSION = require('../package.json').version;

/** opts: config, store | dbPath, now (clock), fetchImpl, auth (a createAuthClient-like object), log */
function createApp(opts = {}) {
    const config = opts.config || configLib.load();
    const log = opts.log || console;
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    const store = opts.store || openStore(opts.dbPath || config.dbPath, { now: opts.now });

    // One context object: domain modules reach each other through it at call time.
    const ctx = { config, store, log };
    ctx.urls = createUrls(config);
    ctx.outbox = createTradeOutbox({ db: store.db, config, fetchImpl, now: store.now, log });
    ctx.instruments = createInstruments({ store });
    ctx.freshness = createFreshness({ store, config, outbox: ctx.outbox });
    ctx.alerts = createAlerts({ store, config, ctx });
    ctx.observations = createObservations({ store, ctx });
    ctx.documents = createDocuments({ store, ctx });
    ctx.watchlists = createWatchlists({ store, config, ctx });
    ctx.context = createContext({ store, config, ctx });
    ctx.indexing = createIndexing({ store, config, ctx });
    ctx.reading = createReading({ store, ctx });
    ctx.sources = opts.sourcesClient || createSourcesClient({ config, fetchImpl });
    ctx.sync = createSync({ store, config, ctx, sources: ctx.sources, log });
    ctx.auth = opts.auth || createAuthClient(config);
    ctx.viewers = createViewerResolver({ auth: ctx.auth, config });
    ctx.common = createCommon({ config, store });
    ctx.worker = createWorker({ config, sync: ctx.sync, freshness: ctx.freshness, indexing: ctx.indexing, outbox: ctx.outbox, log });

    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);
    // metricsPath: open tabs report their update outcomes to POST /release-metrics (defined below).
    const release = require('openvibe-shared/release').createRelease({ service: 'trade', root: path.join(__dirname, '..'), metricsPath: '/release-metrics' });
    const metrics = require('openvibe-shared/metrics').instrument(app, { service: 'trade', release: release.release });
    app.locals.metrics = metrics.registry;
    app.locals.ctx = ctx;

    app.use(contracts.http.middleware());
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                // The OpenVibe Frame (theme-loader, navbar, footer) comes from the Network; the inline init is ours.
                scriptSrc: ["'self'", "'unsafe-inline'", 'https://openvibe.network'],
                styleSrc: ["'self'", "'unsafe-inline'", 'https://openvibe.network', 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
                fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
                imgSrc: ["'self'", 'data:', 'https:'],
                // events.openvibe.network: release notifications (release-watch's EventSource, openvibe-shared 1.17).
                connectSrc: ["'self'", 'https://openvibe.network', 'https://events.openvibe.network'],
                frameSrc: ["'self'", 'https://openvibe.network'],
                frameAncestors: ["'self'"],
                objectSrc: ["'none'"],
                baseUri: ["'self'"],
                formAction: ["'self'", 'https://openvibe.network'],
            },
        },
        crossOriginEmbedderPolicy: false,
        crossOriginResourcePolicy: { policy: 'same-site' },
        referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }));
    app.use(cookieParser());

    // ── Machine endpoints ───────────────────────────────────
    const machine = express.Router();
    define(machine, 'get', '/api/health', 'health', (_req, res) => res.json({ status: 'ok', service: 'openvibe-trade', version: VERSION }));
    // What release.mount(app, { registry }) registers, through define() like every Trade route:
    // GET /release.json (ADR-016) and POST /release-metrics (release_client_updates_total in /metrics).
    define(machine, 'get', '/release.json', 'releaseInfo', release.handler);
    define(machine, 'post', '/release-metrics', 'releaseMetrics', release.collect(metrics.registry));
    const readiness = createTradeReadiness({ store, auth: ctx.auth, outbox: ctx.outbox, sync: ctx.sync, freshness: ctx.freshness, release: release.release });
    define(machine, 'get', '/api/ready', 'readiness', readiness.handler);
    app.use(machine);

    // ── Signed OpenVibe.Events deliveries (before any body parser) ──
    app.use(createWebhook({ store, config, sync: ctx.sync, log }).router);

    // ── Sign-in (OAuth2 client of OpenVibe.Network) ─────────
    app.use('/auth/', rateLimit({ windowMs: 15 * 60_000, max: 60, standardHeaders: true, legacyHeaders: false }));
    app.use('/auth', createAuthRoutes(config, ctx.auth));
    {
        const legal = require('openvibe-shared/legal');
        const legalRouter = express.Router();
        define(legalRouter, 'get', legal.PATHS, 'legalPage', legal.handler({ id: 'trade', service: 'trade', host: 'openvibe.trade', name: 'OpenVibe.Trade', profile: 'information' }));
        app.use(legalRouter);
    }

    // ── Static assets (content-hashed ?v= → immutable) ──────
    // This site's own pinned copy of the OpenVibe Frame's browser files (openvibe-shared/serve).
    app.use('/shared', require('openvibe-shared/serve').handler());
    app.use(express.static(PUBLIC_DIR, {
        index: false, redirect: false,
        setHeaders(res, filePath) {
            const rel = path.relative(PUBLIC_DIR, filePath).split(path.sep).join('/');
            const v = res.req && res.req.query && res.req.query.v;
            res.setHeader('Cache-Control', v && v === assetVersion(rel) ? 'public, max-age=31536000, immutable' : 'public, max-age=300');
        },
    }));

    // ── API ─────────────────────────────────────────────────
    app.use('/api/v1', rateLimit({ windowMs: 60_000, max: 240, standardHeaders: true, legacyHeaders: false }), createApi(ctx));

    // ── Pages (the viewer is resolved for browsers only; service tokens are not identities here) ──
    app.use(ctx.viewers.middleware({ services: false }));
    app.use(createDiscovery(ctx));
    app.use(['/watchlists', '/alerts', '/editor'], rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false }));
    app.use(createPrivate(ctx));
    app.use(createEditor(ctx));
    app.use(createPages(ctx));
    app.use(function pageNotFound(req, res) { ctx.common.notFound(req, res); });

    // eslint-disable-next-line no-unused-vars
    app.use(function errorHandler(err, req, res, _next) {
        log.error('[Trade]', err && err.stack ? err.stack : err);
        if (res.headersSent) return;
        res.set('Cache-Control', 'private, no-store');
        if (req.path.startsWith('/api/')) return contracts.http.sendProblem(res, 500, 'internal.error', { detail: 'Internal error', ctx: req.ov });
        res.status(500).type('text/plain').send('Something went wrong on our side. Try again in a moment.');
    });

    return { app, ctx };
}

module.exports = { createApp };
