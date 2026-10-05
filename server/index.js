'use strict';

/**
 * OpenVibe.Trade — process entry. `node server/index.js`
 * Listens on PORT (4860) behind nginx (deploy/). Starts the outbox relay (when EVENTS_URL and the
 * client secret are set) and the worker (Sources sync, freshness). On SIGTERM/SIGINT the service
 * kit drains in-flight requests (Connection: close), stops the worker and the relay, closes the
 * store, and exits 0 (the 5 s family's deadline exit code).
 */
const { gracefulStop } = require('openvibe-sdk/service');
const { createApp } = require('./app');

(async () => {
const { app, ctx } = await createApp();
const { config } = ctx;

const server = app.listen(config.port, config.host, () => {
    console.log(`[Trade] ${config.nodeEnv} on http://${config.host}:${config.port} → ${config.baseUrl} (db ${ctx.store.db.store})`);
    console.log(`[Trade] events relay ${ctx.outbox.enabled ? `on → ${config.events.url}` : 'off (events wait in event_outbox)'}; Sources sync ${ctx.sync.enabled ? 'on' : 'off'}; worker ${config.worker.enabled ? 'on' : 'off'}`);
});
server.keepAliveTimeout = 65_000;
ctx.outbox.start();
ctx.worker.start();

gracefulStop({
    name: 'Trade', server, deadlineExitCode: 0,
    stop: [() => ctx.worker.stop()],
    close: [() => ctx.outbox.stop(), () => ctx.store.close()],
});
})().catch((err) => { console.error('[Trade] failed to start:', err); process.exit(1); });
