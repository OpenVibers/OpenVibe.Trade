'use strict';

/**
 * Trade's own PostgreSQL database (ADR-035, roadmap WS-X2): the schema is migrations/NNNN_*.sql, applied at boot.
 * Nothing here is shared with another
 * service.
 *
 * The nine charter tables (roadmap §15.13):
 *
 *   trade_instruments          Trade-owned  symbol, name, kind, exchange, CIK, status, which context
 *                                           revision is published
 *   trade_instrument_aliases   Trade-owned  tickers, CIKs and names that resolve to an instrument
 *   trade_watchlists           Trade-owned  private, one owner subject (usr_…)
 *   trade_watchlist_items      Trade-owned  instruments on a watchlist
 *   trade_market_observations  Trade-owned  value, unit, currency, observed_at, source, retrieved_at;
 *                                           immutable (triggers abort UPDATE and DELETE)
 *   trade_source_documents     Trade-owned  filings and other documents from OpenVibe.Sources items
 *   trade_alert_rules          Trade-owned  threshold | filing_type | new_document, private per owner
 *   trade_alert_deliveries     Trade-owned  one row per (rule, triggering observation or document):
 *                                           the UNIQUE key is what makes alerts idempotent
 *   trade_context_revisions    package      openvibe-publishing/revisions, prefix trade_context
 *                                           (immutable; editor-written or reviewed AI drafts)
 *
 * Also here: trade_context_drafts / trade_context_revision_purges / trade_context_reviews (package
 * companions), trade_index_revisions (Search document sequencer), trade_source_status (freshness
 * per source), trade_sync_state (the Sources cursor), event_outbox (SDK outbox) and
 * idempotency_receipts (SDK inbox for signed webhook deliveries).
 */
const fs = require('fs');
const path = require('path');
const { createDb } = require('openvibe-sdk/db');
const { createRevisionStore } = require('openvibe-publishing/revisions');
const { createReviewLog } = require('openvibe-publishing/authorship');
const { createIndexSequencer } = require('openvibe-publishing/index-hooks');

const MIGRATIONS = path.join(__dirname, '..', 'migrations');
const DEV_PGLITE = path.join(__dirname, '..', 'data', 'pglite');

/**
 * The serving handle (ADR-035): DATABASE_URL through PgBouncer; in development without it, an embedded PGlite database
 * in data/pglite. Migrations run first, as the owner (DATABASE_DIRECT_URL), or on the embedded handle.
 */
async function openDb(config, { log = console, registry } = {}) {
    if (!config.db.url) {
        if (config.isProduction) throw new Error('DATABASE_URL is not set: production serves from PostgreSQL (OpenVibe.Host roles/data add-service.sh trade)');
        log.warn(`[Trade] DATABASE_URL unset: embedded PGlite database in ${DEV_PGLITE} (development only, one process)`);
        fs.mkdirSync(DEV_PGLITE, { recursive: true });
        const db = createDb({ pglite: DEV_PGLITE, service: 'trade', registry, log });
        await db.migrate({ dir: MIGRATIONS, log });
        return db;
    }
    if (!config.db.directUrl) throw new Error('DATABASE_DIRECT_URL is not set: migrations run with the owner role on a direct connection');
    const owner = createDb({ url: config.db.directUrl, service: 'trade-migrate', max: 1, log });
    try { await owner.migrate({ dir: MIGRATIONS, log }); } finally { await owner.close(); }
    return createDb({ url: config.db.url, service: 'trade', registry, log });
}

/**
 * Every store on a migrated database handle. opts.now — injectable clock (epoch ms), so tests and replays are
 * deterministic. store.tx(fn) is a transaction; inside it, plain db calls join it (ambient).
 */
function createStore(db, { now = () => Date.now() } = {}) {
    return {
        db,
        now,
        revisions: createRevisionStore(db, { prefix: 'trade_context', now }),
        reviews: createReviewLog(db, { prefix: 'trade_context', now }),
        sequencer: createIndexSequencer(db, { prefix: 'trade', now }),
        tx: async (fn) => await db.tx(() => fn()),
        close: () => db.close(),
    };
}

/** openDb + createStore. */
async function openStore(config, { now, log } = {}) {
    return createStore(await openDb(config, { log }), { now });
}

const CHARTER_TABLES = ['trade_instruments', 'trade_instrument_aliases', 'trade_watchlists', 'trade_watchlist_items',
    'trade_market_observations', 'trade_source_documents', 'trade_alert_rules', 'trade_alert_deliveries', 'trade_context_revisions'];

module.exports = { openDb, openStore, createStore, MIGRATIONS, CHARTER_TABLES };
