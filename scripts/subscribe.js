#!/usr/bin/env node
'use strict';

/**
 * scripts/subscribe.js — subscribe Trade to OpenVibe.Events and optionally reconcile.
 *
 * Usage:
 *   node scripts/subscribe.js              # subscribe only
 *   node scripts/subscribe.js --reconcile  # subscribe, then refresh all indexing and kick outbox
 *   node scripts/subscribe.js --endpoint http://127.0.0.1:4860/internal/events
 *
 * Posts to {EVENTS_URL}/api/v1/subscriptions with a service token (events.subscription.manage for
 * audience openvibe.events) and the configured webhook secret. Events delivers to this service's own
 * loopback webhook (127.0.0.1:PORT/internal/events), never the public origin: nginx does not proxy
 * /internal/. A 409 response (subscription already exists) prints 'exists' and continues.
 * The webhook secret must be at least 32 characters (guard against weak secrets).
 *
 * --reconcile runs ctx.store.tx(() => ctx.indexing.refreshAll()) then ctx.outbox.kick(),
 * which re-evaluates all instrument pages and wakes the outbox relay.
 */

const { serviceAuth } = require('openvibe-contracts');
const { load } = require('../server/config');
const { openStore } = require('../server/db');

const RECONCILE = process.argv.includes('--reconcile');

/** Read a `--name <value>` option from argv (undefined when absent). */
function option(name, argv = process.argv) {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
}

/** The endpoint Events delivers to: this service's own inbound webhook. */
const defaultEndpoint = (config) => `http://127.0.0.1:${config.port}/internal/events`;

async function subscribe(config, { fetch: fetchImpl = globalThis.fetch, tokens = null, endpoint } = {}) {
    const secret = config.events.webhookSecret;
    if (!secret) {
        throw new Error('TRADE_EVENTS_WEBHOOK_SECRET is not set; cannot subscribe');
    }
    if (secret.length < 32) {
        throw new Error(`webhook secret is too short (${secret.length} < 32); set a stronger TRADE_EVENTS_WEBHOOK_SECRET`);
    }
    if (!config.events.url) {
        throw new Error('EVENTS_URL is not set; cannot subscribe');
    }
    if (!config.oauth.clientSecret) {
        throw new Error('OV_OAUTH_CLIENT_SECRET is not set; cannot subscribe as the trade principal');
    }

    const auth = tokens || serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.events',
        scope: 'events.subscription.manage',
    });

    const url = `${config.events.url}/api/v1/subscriptions`;
    const body = {
        topic_pattern: 'sources.*',
        endpoint: endpoint || defaultEndpoint(config),
        secret,
    };

    const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(await auth.authHeaders()) },
        body: JSON.stringify(body),
    });

    if (res.status === 409) {
        const data = await res.json().catch(() => ({}));
        console.log('exists', data.subscription_id || '');
        return { created: false, subscription_id: data.subscription_id || null };
    }
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`subscription failed: ${res.status} ${text}`);
    }

    const data = await res.json();
    console.log('subscribed', data.subscription_id || data.id || '');
    return { created: true, subscription_id: data.subscription_id || data.id || null };
}

async function reconcile(ctx) {
    await ctx.store.tx(() => ctx.indexing.refreshAll());
    await ctx.outbox.kick();
}

async function main() {
    const config = load();
    const log = console;

    const endpoint = option('endpoint');
    log.log(`[Trade subscribe] port ${config.port}, events ${config.events.url || '(unset)'}, endpoint ${endpoint || defaultEndpoint(config)}`);

    const result = await subscribe(config, { endpoint });
    log.log(`[Trade subscribe] ${result.created ? 'created' : 'exists'}: ${result.subscription_id || '(no id)'}`);

    if (RECONCILE) {
        log.log('[Trade subscribe] reconciling (refreshAll + kick)');
        const store = await openStore(config, { log });
        const ctx = {
            config,
            store,
            indexing: require('../server/domain/indexing').createIndexing({
                store,
                config,
                ctx: {
                    urls: require('../server/domain/urls').createUrls(config),
                    instruments: require('../server/domain/instruments').createInstruments({ store }),
                    outbox: require('openvibe-sdk/events').createServiceOutbox({
                        db: store.db,
                        source: 'trade',
                        eventsUrl: config.events.url,
                        networkInternalUrl: config.networkInternalUrl,
                        clientId: config.oauth.clientId,
                        clientSecret: config.oauth.clientSecret,
                        intervalMs: config.events.intervalMs,
                        now: store.now,
                        log,
                    }),
                },
                indexnow: { enabled: false },
            }),
            outbox: require('openvibe-sdk/events').createServiceOutbox({
                db: store.db,
                source: 'trade',
                eventsUrl: config.events.url,
                networkInternalUrl: config.networkInternalUrl,
                clientId: config.oauth.clientId,
                clientSecret: config.oauth.clientSecret,
                intervalMs: config.events.intervalMs,
                now: store.now,
                log,
            }),
        };
        await reconcile(ctx);
        log.log('[Trade subscribe] reconcile complete');
        await store.close();
    }
}

if (require.main === module) {
    main().catch((err) => {
        console.error('[Trade subscribe] failed:', err.message);
        process.exit(1);
    });
}

module.exports = { subscribe, reconcile };
