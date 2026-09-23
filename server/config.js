'use strict';

/**
 * OpenVibe.Trade configuration. Every value comes from the environment (production:
 * /etc/openvibe/trade.env, see .env.example). Only environment variable NAMES appear in code and
 * docs; secrets are never logged.
 *
 * load(env) is pure so tests can build a config without touching process.env.
 */
require('dotenv').config();

const trim = (s) => String(s || '').replace(/\/+$/, '');
const int = (v, def) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : def);
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

function load(env = process.env) {
    const nodeEnv = env.NODE_ENV || 'development';
    const isProduction = nodeEnv === 'production';
    const port = int(env.PORT, 4860);
    const baseUrl = trim(env.BASE_URL || (isProduction ? 'https://openvibe.trade' : `http://localhost:${port}`));

    return {
        service: 'trade',
        port,
        host: env.HOST || '127.0.0.1',
        nodeEnv,
        isProduction,
        // Public origin: canonical URLs, feeds, sitemaps and JSON-LD are built from it.
        baseUrl,
        trustProxy: env.TRUST_PROXY != null ? Number(env.TRUST_PROXY) : 2,

        dbPath: env.TRADE_DB_PATH || './data/trade.db',

        // OpenVibe.Network: SSO (OAuth2 authorization server), JWKS, client-credentials tokens.
        networkUrl: trim(env.OV_NETWORK_URL || 'https://openvibe.network'),
        networkInternalUrl: trim(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000'),
        oauth: {
            clientId: env.OV_OAUTH_CLIENT_ID || 'trade',
            clientSecret: env.OV_OAUTH_CLIENT_SECRET || '',
            redirectUri: env.OV_OAUTH_REDIRECT_URI || `${baseUrl}/auth/callback`,
            scope: 'profile theme',
        },
        cookies: { secure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProduction },
        // Signs the per-session form token (CSRF). Unset: a random per-process key.
        formSecret: env.TRADE_FORM_SECRET || '',

        // Editors: Network subjects (usr_…) who may create instruments, write context and review
        // AI drafts. Network admins are editors too.
        editors: list(env.TRADE_EDITORS),

        // OpenVibe.Sources: the trade category (filings, market data feeds). Read with a service
        // token (sources.item.read, sources.source.read). Off until the client secret is set.
        sources: {
            internalUrl: trim(env.OV_SOURCES_INTERNAL_URL || 'http://127.0.0.1:4720'),
            category: 'trade',
            syncIntervalMs: int(env.TRADE_SYNC_INTERVAL_MS, 60_000),
            pageLimit: Math.min(Math.max(int(env.TRADE_SYNC_PAGE_LIMIT, 200), 1), 500),
            maxPagesPerRun: Math.max(int(env.TRADE_SYNC_MAX_PAGES, 20), 1),
        },

        // Freshness. A source without its own window (Sources' stale_after_sec) uses this one.
        freshness: {
            defaultStaleAfterSec: Math.max(int(env.TRADE_DEFAULT_STALE_AFTER_SEC, 3 * 3600), 60),
            // How old a monetary observation may be before the page is noindex (stale_price).
            priceMaxAgeMs: Math.max(int(env.TRADE_PRICE_MAX_AGE_SEC, 24 * 3600), 60) * 1000,
        },

        // Indexability policy for instrument pages (openvibe-publishing/seo gate). Financial pages
        // are a sensitive category: nothing is indexable before a person-reviewed context exists.
        gate: { minWords: Math.max(int(env.TRADE_GATE_MIN_WORDS, 60), 0) },

        // OpenVibe.Events: the outbox relay runs only when EVENTS_URL and the client secret are set.
        events: {
            url: trim(env.EVENTS_URL || ''),
            intervalMs: int(env.EVENTS_RELAY_INTERVAL_MS, 2000),
            // Signed webhook deliveries (sources.* topics) wake the Sources sync early.
            webhookSecret: env.TRADE_EVENTS_WEBHOOK_SECRET || '',
        },

        worker: {
            enabled: env.TRADE_WORKER !== 'off',
            freshnessIntervalMs: int(env.TRADE_FRESHNESS_INTERVAL_MS, 60_000),
        },

        // Browser origins that may call /api/v1 with a Bearer Network JWT (no cookies cross origins).
        apiCorsOrigins: list(env.API_CORS_ORIGINS || 'https://openvibe.network'),

        limits: {
            watchlistsPerSubject: 20,
            itemsPerWatchlist: 200,
            alertRulesPerSubject: 100,
        },
    };
}

module.exports = { load };
