'use strict';

/**
 * Trade's own SQLite database: created on boot, idempotently. Nothing here is shared with another
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
const Database = require('better-sqlite3');
const { createRevisionStore } = require('openvibe-publishing/revisions');
const { createReviewLog } = require('openvibe-publishing/authorship');
const { createIndexSequencer } = require('openvibe-publishing/index-hooks');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS trade_instruments (
    id                         TEXT PRIMARY KEY,               -- ins_<ULID>
    symbol                     TEXT NOT NULL UNIQUE,           -- canonical display ticker, upper case: /i/:symbol
    name                       TEXT NOT NULL,
    kind                       TEXT NOT NULL CHECK (kind IN ('equity','fund','index','currency','commodity','crypto','other')),
    exchange                   TEXT,                           -- as an editor recorded it; NULL = not recorded
    cik                        TEXT UNIQUE,                    -- SEC Central Index Key, 10 digits zero-padded
    currency                   TEXT,                           -- ISO 4217 trading currency, when recorded
    status                     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
    context_published_revision INTEGER,                        -- trade_context_revisions.number readers see
    context_published_at       INTEGER,
    created_by                 TEXT,                           -- usr_… or svc:…
    created_at                 INTEGER NOT NULL,
    updated_at                 INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS trade_instrument_aliases (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    instrument_id  TEXT NOT NULL REFERENCES trade_instruments(id),
    kind           TEXT NOT NULL CHECK (kind IN ('ticker','cik','name')),
    value          TEXT NOT NULL,                              -- as entered
    normalized     TEXT NOT NULL,                              -- the resolution key (see domain/instruments.js)
    added_by       TEXT,
    created_at     INTEGER NOT NULL,
    UNIQUE (instrument_id, kind, normalized)
);
-- A ticker or CIK names exactly one instrument; a name may be shared (resolution is then ambiguous).
CREATE UNIQUE INDEX IF NOT EXISTS trade_aliases_unique_key ON trade_instrument_aliases (kind, normalized) WHERE kind IN ('ticker','cik');
CREATE INDEX IF NOT EXISTS trade_aliases_lookup ON trade_instrument_aliases (kind, normalized);

CREATE TABLE IF NOT EXISTS trade_watchlists (
    id             TEXT PRIMARY KEY,                           -- wl_<ULID>
    owner_subject  TEXT NOT NULL,                              -- usr_…; never shown to anyone else
    name           TEXT NOT NULL,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    UNIQUE (owner_subject, name)
);

CREATE TABLE IF NOT EXISTS trade_watchlist_items (
    watchlist_id   TEXT NOT NULL REFERENCES trade_watchlists(id) ON DELETE CASCADE,
    instrument_id  TEXT NOT NULL REFERENCES trade_instruments(id),
    note           TEXT,
    added_at       INTEGER NOT NULL,
    PRIMARY KEY (watchlist_id, instrument_id)
);

CREATE TABLE IF NOT EXISTS trade_market_observations (
    id              TEXT PRIMARY KEY,                          -- obs_<ULID>
    instrument_id   TEXT NOT NULL REFERENCES trade_instruments(id),
    metric          TEXT NOT NULL,                             -- e.g. price.close, volume, us-gaap:Revenues
    value           TEXT NOT NULL,                             -- the decimal exactly as the source stated it
    value_num       REAL NOT NULL,                             -- the same value, for comparisons only
    unit            TEXT NOT NULL,                             -- USD, shares, USD/share, pure, …
    currency        TEXT,                                      -- ISO 4217 when the value is monetary
    period          TEXT,                                      -- e.g. 2026-Q2, when the source states one
    observed_at     INTEGER NOT NULL,                          -- when the value was true, per the source
    source_key      TEXT NOT NULL,                             -- OpenVibe.Sources source key
    source_item_id  TEXT,                                      -- itm_… when it came from a Sources item
    source_url      TEXT,
    source_ref      TEXT NOT NULL,                             -- the source's own identity of this datum
    retrieved_at    INTEGER NOT NULL,                          -- when the source was fetched
    max_age_sec     INTEGER,                                   -- the value is stale after this long (NULL: only the source's freshness)
    recorded_by     TEXT NOT NULL,                             -- svc:… (a feed) or usr_… (never inferred)
    recorded_at     INTEGER NOT NULL,
    UNIQUE (source_key, source_ref)
);
CREATE INDEX IF NOT EXISTS trade_obs_series ON trade_market_observations (instrument_id, metric, observed_at);
CREATE TRIGGER IF NOT EXISTS trade_obs_no_update BEFORE UPDATE ON trade_market_observations
    BEGIN SELECT RAISE(ABORT, 'trade_market_observations rows are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trade_obs_no_delete BEFORE DELETE ON trade_market_observations
    BEGIN SELECT RAISE(ABORT, 'trade_market_observations rows are immutable'); END;

CREATE TABLE IF NOT EXISTS trade_source_documents (
    id                  TEXT PRIMARY KEY,                      -- doc_<ULID>
    instrument_id       TEXT NOT NULL REFERENCES trade_instruments(id),
    source_key          TEXT NOT NULL,
    source_item_id      TEXT NOT NULL UNIQUE,                  -- itm_…: Sources owns the item
    source_revision     INTEGER NOT NULL,
    kind                TEXT NOT NULL CHECK (kind IN ('filing','article','record')),
    form_type           TEXT,                                  -- 10-K, 8-K, … when the source states it
    title               TEXT,
    filer_name          TEXT,
    cik                 TEXT,
    accession           TEXT,
    url                 TEXT,
    published_at        INTEGER,                               -- the source's own date; NULL if it gave none
    source_updated_at   INTEGER,
    retrieved_at        INTEGER NOT NULL,
    first_seen_at       INTEGER NOT NULL,
    license_note        TEXT,
    terms_note          TEXT,
    removed_at          INTEGER,
    removed_reason      TEXT,
    recorded_at         INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS trade_docs_instrument ON trade_source_documents (instrument_id, removed_at, published_at);

CREATE TABLE IF NOT EXISTS trade_alert_rules (
    id                 TEXT PRIMARY KEY,                       -- alr_<ULID>
    owner_subject      TEXT NOT NULL,
    instrument_id      TEXT NOT NULL REFERENCES trade_instruments(id),
    kind               TEXT NOT NULL CHECK (kind IN ('threshold','filing_type','new_document')),
    metric             TEXT,
    operator           TEXT CHECK (operator IN ('above','below')),
    threshold          TEXT,
    threshold_num      REAL,
    unit               TEXT,
    currency           TEXT,
    form_types         TEXT,                                   -- JSON array (filing_type rules)
    armed              INTEGER NOT NULL DEFAULT 1,             -- threshold rules fire on a crossing, then re-arm
    last_observed_at   INTEGER,                                -- newest observation a threshold rule evaluated
    status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deleted')),
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL,
    CHECK (kind <> 'threshold' OR (metric IS NOT NULL AND operator IS NOT NULL AND threshold IS NOT NULL AND unit IS NOT NULL)),
    CHECK (kind <> 'filing_type' OR form_types IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS trade_rules_owner ON trade_alert_rules (owner_subject, status);
CREATE INDEX IF NOT EXISTS trade_rules_instrument ON trade_alert_rules (instrument_id, status, kind);

CREATE TABLE IF NOT EXISTS trade_alert_deliveries (
    id             TEXT PRIMARY KEY,                           -- ald_<ULID>
    rule_id        TEXT NOT NULL REFERENCES trade_alert_rules(id),
    owner_subject  TEXT NOT NULL,
    trigger_kind   TEXT NOT NULL CHECK (trigger_kind IN ('observation','document')),
    trigger_id     TEXT NOT NULL,
    event_id       TEXT,                                       -- the trade.alert.triggered envelope
    summary        TEXT NOT NULL,                              -- JSON snapshot of what triggered it
    created_at     INTEGER NOT NULL,
    UNIQUE (rule_id, trigger_kind, trigger_id)
);
CREATE INDEX IF NOT EXISTS trade_deliveries_owner ON trade_alert_deliveries (owner_subject, created_at);

-- Freshness of each source Trade shows data from (not a charter table; a projection of Sources'
-- health plus Trade's own clock).
CREATE TABLE IF NOT EXISTS trade_source_status (
    source_key        TEXT PRIMARY KEY,
    name              TEXT,
    upstream_status   TEXT,                                    -- Sources' health status, NULL = never reported
    last_success_at   INTEGER,                                 -- last successful fetch (Sources, or the newest retrieval Trade recorded)
    stale_after_sec   INTEGER,
    reported_at       INTEGER,                                 -- when Sources last told us about it
    stale             INTEGER NOT NULL DEFAULT 1,              -- as of the last evaluation
    stale_since       INTEGER,
    evaluated_at      INTEGER,
    terms_note        TEXT,
    license_note      TEXT
);

CREATE TABLE IF NOT EXISTS trade_sync_state (
    name          TEXT PRIMARY KEY,
    cursor        INTEGER NOT NULL DEFAULT 0,
    last_ok_at    INTEGER,
    last_error    TEXT,
    last_error_at INTEGER,
    counts        TEXT NOT NULL DEFAULT '{}'
);
`;

/**
 * Open (or create) the database and the package stores on it.
 * opts.now — injectable clock (epoch ms) shared by everything, so tests are deterministic.
 */
function openStore(dbPath, { now = () => Date.now() } = {}) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.exec(SCHEMA);
    return {
        db,
        now,
        revisions: createRevisionStore(db, { prefix: 'trade_context', now }),
        reviews: createReviewLog(db, { prefix: 'trade_context', now }),
        sequencer: createIndexSequencer(db, { prefix: 'trade', now }),
        tx: (fn) => db.transaction(fn)(),
        close: () => db.close(),
    };
}

const CHARTER_TABLES = ['trade_instruments', 'trade_instrument_aliases', 'trade_watchlists', 'trade_watchlist_items',
    'trade_market_observations', 'trade_source_documents', 'trade_alert_rules', 'trade_alert_deliveries', 'trade_context_revisions'];

module.exports = { openStore, CHARTER_TABLES };
