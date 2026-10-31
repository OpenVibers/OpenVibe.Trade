'use strict';

/**
 * OpenVibe.Trade — process entry. `node server/index.js`
 * Listens on PORT (4860) behind nginx (deploy/). Starts the outbox relay (when EVENTS_URL and the
 * client secret are set) and the worker (Sources sync, freshness). On SIGTERM/SIGINT the service
 * kit drains in-flight requests (Connection: close), stops the worker and the relay, closes the
 * store, and exits 0 (the 5 s family's deadline exit code).
 */
const { gracefulStop } = require('openvibe-sdk/service');
const { startTelemetryRetention } = require('openvibe-sdk/telemetry');
const { startSubscriptions } = require('openvibe-sdk/account-data');
const { createApp } = require('./app');

(async () => {
const { app, ctx } = await createApp();
const { config } = ctx;

// Socket activation (2026-10-31): systemd's .socket unit holds the listener across restarts, so a deploy
// queues requests in the kernel instead of answering 502. Without the socket unit, the usual listen.
const socketActivated = process.env.LISTEN_FDS === '1' && Number(process.env.LISTEN_PID) === process.pid;
const server = app.listen(...(socketActivated ? [{ fd: 3 }] : [config.port, config.host]), () => {
    console.log(`[Trade] ${config.nodeEnv} on http://${config.host}:${config.port} → ${config.baseUrl} (db ${ctx.store.db.store})`);
    console.log(`[Trade] events relay ${ctx.outbox.enabled ? `on → ${config.events.url}` : 'off (events wait in event_outbox)'}; Sources sync ${ctx.sync.enabled ? 'on' : 'off'}; worker ${config.worker.enabled ? 'on' : 'off'}`);
});
server.keepAliveTimeout = 65_000;
ctx.outbox.start();
ctx.worker.start();
// telemetry_samples rows older than 14 days go: a minute after start, then daily (openvibe-sdk/telemetry).
ctx.retention = startTelemetryRetention({ db: ctx.store.db, log: console, olderThanDays: 14 });
// The request collector aggregates in memory and has no timer of its own (openvibe-sdk 0.46 createHttpTelemetry):
// this tick writes each minute's samples; the stop clears it and flushes once more.
ctx.telemetryTick = setInterval(() => { ctx.telemetry.flush().catch(() => {}); }, 60_000);
ctx.telemetryTick.unref();
// The two account subscriptions at OpenVibe.Events (ADR-033), created when missing; off without EVENTS_URL,
// TRADE_EVENTS_WEBHOOK_SECRET or the client secret. The sources.* one stays scripts/subscribe.js's.
const subscriptions = startSubscriptions({
    eventsUrl: config.events.url, endpoint: `http://127.0.0.1:${config.port}/internal/events`, secret: String(config.events.webhookSecret || '').split(',')[0].trim(),
    networkInternalUrl: config.networkInternalUrl, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
});

gracefulStop({
    name: 'Trade', server, deadlineExitCode: 0,
    stop: [() => ctx.worker.stop(), () => { if (subscriptions) subscriptions.stop(); }],
    close: [() => ctx.outbox.stop(), async () => { clearInterval(ctx.telemetryTick); if (ctx.retention) await ctx.retention.stop(); if (ctx.telemetry) await ctx.telemetry.stop(); }, () => ctx.store.close()],
});
})().catch((err) => { console.error('[Trade] failed to start:', err); process.exit(1); });
