'use strict';

/**
 * OpenVibe.Trade — process entry. `node server/index.js`
 * Listens on PORT (4860) behind nginx (deploy/). Starts the outbox relay (when EVENTS_URL and the
 * client secret are set) and the worker (Sources sync, freshness).
 */
const { createApp } = require('./app');

const { app, ctx } = createApp();
const { config } = ctx;

const server = app.listen(config.port, config.host, () => {
    console.log(`[Trade] ${config.nodeEnv} on http://${config.host}:${config.port} → ${config.baseUrl} (db ${config.dbPath})`);
    console.log(`[Trade] events relay ${ctx.outbox.enabled ? `on → ${config.events.url}` : 'off (events wait in event_outbox)'}; Sources sync ${ctx.sync.enabled ? 'on' : 'off'}; worker ${config.worker.enabled ? 'on' : 'off'}`);
});
server.keepAliveTimeout = 65_000;
ctx.outbox.start();
ctx.worker.start();

function shutdown(signal) {
    console.log(`[Trade] ${signal}: closing`);
    ctx.worker.stop();
    server.close(async () => {
        try { await ctx.outbox.stop(); } catch { /* best effort */ }
        try { ctx.store.close(); } catch { /* already closed */ }
        process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
