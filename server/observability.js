'use strict';
/**
 * Truthful readiness for GET /api/ready (openvibe-shared/ready).
 *
 *   db              required  a real query on Trade's SQLite (the nine charter tables answer)
 *   network_jwks    optional  the Network signing key has loaded; without it pages and feeds
 *                             serve, but nobody can sign in and service tokens are refused (503)
 *   events_relay    optional  the outbox relay is configured and has no rejected rows
 *   sources_sync    optional  the Sources sync is configured and its last run succeeded; while it
 *                             fails, pages keep serving what was recorded and mark it stale
 *   freshness       optional  how many sources are stale right now (information, never hidden)
 */
const { createReadiness } = require('openvibe-shared/ready');
const { CHARTER_TABLES } = require('./db');

function createTradeReadiness({ store, auth, outbox, sync, freshness, valkey = null, release = null }) {
    const { db } = store;
    return createReadiness({
        service: 'trade',
        release,
        checks: [
            {
                name: 'db', required: true,
                check: async () => {
                    // A real round trip that names the store (postgresql / pglite), and the charter tables present.
                    const r = await db.ready();
                    if (!r.ok) return r.error;
                    const names = new Set((await db.prepare('SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema()').all()).map((x) => x.name));
                    const missing = CHARTER_TABLES.filter((t) => !names.has(t));
                    return missing.length ? `missing ${missing.join(', ')} (migrations did not run)` : { ok: true, detail: r.detail };
                },
            },
            { name: 'valkey', required: false, check: async () => (valkey ? valkey.ready() : { skipped: 'VALKEY_URL not set: per-actor limits count in this process only' }) },
            {
                name: 'network_jwks', required: false,
                check: () => {
                    if (auth.client.publicKey) return true;
                    auth.ensureKey().catch(() => {});
                    return 'Network signing key not loaded yet: sign-in and service calls are unavailable';
                },
            },
            {
                name: 'events_relay', required: false,
                check: async () => {
                    const s = await outbox.status();
                    if (!s.enabled) return `relay off (EVENTS_URL or OV_OAUTH_CLIENT_SECRET unset); ${s.pending} events waiting`;
                    if (s.rejected) return `${s.rejected} events rejected by OpenVibe.Events`;
                    return { ok: true, detail: { pending: s.pending } };
                },
            },
            {
                name: 'sources_sync', required: false,
                check: async () => {
                    const s = await sync.state();
                    if (!s.enabled) return 'Sources sync off (OV_OAUTH_CLIENT_SECRET unset): no new filings or observations arrive';
                    if (s.last_error) return `last Sources sync failed: ${s.last_error}`;
                    if (!s.last_ok_at) return 'Sources sync has not completed yet';
                    return { ok: true, detail: { cursor: s.cursor, last_ok_at: s.last_ok_at } };
                },
            },
            {
                name: 'freshness', required: false,
                check: async () => {
                    const all = await freshness.all();
                    const stale = all.filter((s) => s.stale).map((s) => s.key);
                    return stale.length ? `${stale.length} of ${all.length} sources stale: ${stale.slice(0, 10).join(', ')}` : { ok: true, detail: { sources: all.length } };
                },
            },
        ],
    });
}

module.exports = { createTradeReadiness };
