-- phase: expand
-- OpenVibe.Trade on PostgreSQL (ADR-035, roadmap WS-X2): the tables as they were on SQLite (converted by openvibe-sdk
-- tools/asyncify/sqlite-schema-to-pg: text COLLATE "C" compares like SQLite, integers are bigint, identities keep their ids),
-- then the openvibe-publishing stores and the openvibe-sdk inbox and outbox. Generated once on 2026-09-28; never edited after it runs.

CREATE TABLE trade_instruments (
    id                         text COLLATE "C" PRIMARY KEY,               -- ins_<ULID>
    symbol                     text COLLATE "C" NOT NULL UNIQUE,           -- canonical display ticker, upper case: /i/:symbol
    name                       text COLLATE "C" NOT NULL,
    kind                       text COLLATE "C" NOT NULL CHECK (kind IN ('equity','fund','index','currency','commodity','crypto','other')),
    exchange                   text COLLATE "C",                           -- as an editor recorded it; NULL = not recorded
    cik                        text COLLATE "C" UNIQUE,                    -- SEC Central Index Key, 10 digits zero-padded
    currency                   text COLLATE "C",                           -- ISO 4217 trading currency, when recorded
    status                     text COLLATE "C" NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
    context_published_revision bigint,                        -- trade_context_revisions.number readers see
    context_published_at       bigint,
    created_by                 text COLLATE "C",                           -- usr_… or svc:…
    created_at                 bigint NOT NULL,
    updated_at                 bigint NOT NULL
);

CREATE TABLE trade_instrument_aliases (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    instrument_id  text COLLATE "C" NOT NULL REFERENCES trade_instruments(id),
    kind           text COLLATE "C" NOT NULL CHECK (kind IN ('ticker','cik','name')),
    value          text COLLATE "C" NOT NULL,                              -- as entered
    normalized     text COLLATE "C" NOT NULL,                              -- the resolution key (see domain/instruments.js)
    added_by       text COLLATE "C",
    created_at     bigint NOT NULL,
    UNIQUE (instrument_id, kind, normalized)
);
-- A ticker or CIK names exactly one instrument; a name may be shared (resolution is then ambiguous).
CREATE UNIQUE INDEX trade_aliases_unique_key ON trade_instrument_aliases (kind, normalized) WHERE kind IN ('ticker','cik');
CREATE INDEX trade_aliases_lookup ON trade_instrument_aliases (kind, normalized);

CREATE TABLE trade_watchlists (
    id             text COLLATE "C" PRIMARY KEY,                           -- wl_<ULID>
    owner_subject  text COLLATE "C" NOT NULL,                              -- usr_…; never shown to anyone else
    name           text COLLATE "C" NOT NULL,
    created_at     bigint NOT NULL,
    updated_at     bigint NOT NULL,
    UNIQUE (owner_subject, name)
);

CREATE TABLE trade_watchlist_items (
    watchlist_id   text COLLATE "C" NOT NULL REFERENCES trade_watchlists(id) ON DELETE CASCADE,
    instrument_id  text COLLATE "C" NOT NULL REFERENCES trade_instruments(id),
    note           text COLLATE "C",
    added_at       bigint NOT NULL,
    PRIMARY KEY (watchlist_id, instrument_id)
);

CREATE TABLE trade_market_observations (
    id              text COLLATE "C" PRIMARY KEY,                          -- obs_<ULID>
    instrument_id   text COLLATE "C" NOT NULL REFERENCES trade_instruments(id),
    metric          text COLLATE "C" NOT NULL,                             -- e.g. price.close, volume, us-gaap:Revenues
    value           text COLLATE "C" NOT NULL,                             -- the decimal exactly as the source stated it
    value_num       double precision NOT NULL,                             -- the same value, for comparisons only
    unit            text COLLATE "C" NOT NULL,                             -- USD, shares, USD/share, pure, …
    currency        text COLLATE "C",                                      -- ISO 4217 when the value is monetary
    period          text COLLATE "C",                                      -- e.g. 2026-Q2, when the source states one
    observed_at     bigint NOT NULL,                          -- when the value was true, per the source
    source_key      text COLLATE "C" NOT NULL,                             -- OpenVibe.Sources source key
    source_item_id  text COLLATE "C",                                      -- itm_… when it came from a Sources item
    source_url      text COLLATE "C",
    source_ref      text COLLATE "C" NOT NULL,                             -- the source's own identity of this datum
    retrieved_at    bigint NOT NULL,                          -- when the source was fetched
    max_age_sec     bigint,                                   -- the value is stale after this long (NULL: only the source's freshness)
    recorded_by     text COLLATE "C" NOT NULL,                             -- svc:… (a feed) or usr_… (never inferred)
    recorded_at     bigint NOT NULL,
    UNIQUE (source_key, source_ref)
);
CREATE INDEX trade_obs_series ON trade_market_observations (instrument_id, metric, observed_at);
CREATE FUNCTION trade_obs_no_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'trade_market_observations rows are immutable'; END $$;
CREATE TRIGGER trade_obs_no_update BEFORE UPDATE ON trade_market_observations FOR EACH ROW EXECUTE FUNCTION trade_obs_no_update();
CREATE FUNCTION trade_obs_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'trade_market_observations rows are immutable'; END $$;
CREATE TRIGGER trade_obs_no_delete BEFORE DELETE ON trade_market_observations FOR EACH ROW EXECUTE FUNCTION trade_obs_no_delete();

CREATE TABLE trade_source_documents (
    id                  text COLLATE "C" PRIMARY KEY,                      -- doc_<ULID>
    instrument_id       text COLLATE "C" NOT NULL REFERENCES trade_instruments(id),
    source_key          text COLLATE "C" NOT NULL,
    source_item_id      text COLLATE "C" NOT NULL UNIQUE,                  -- itm_…: Sources owns the item
    source_revision     bigint NOT NULL,
    kind                text COLLATE "C" NOT NULL CHECK (kind IN ('filing','article','record')),
    form_type           text COLLATE "C",                                  -- 10-K, 8-K, … when the source states it
    title               text COLLATE "C",
    filer_name          text COLLATE "C",
    cik                 text COLLATE "C",
    accession           text COLLATE "C",
    url                 text COLLATE "C",
    published_at        bigint,                               -- the source's own date; NULL if it gave none
    source_updated_at   bigint,
    retrieved_at        bigint NOT NULL,
    first_seen_at       bigint NOT NULL,
    license_note        text COLLATE "C",
    terms_note          text COLLATE "C",
    removed_at          bigint,
    removed_reason      text COLLATE "C",
    recorded_at         bigint NOT NULL,
    updated_at          bigint NOT NULL
);
CREATE INDEX trade_docs_instrument ON trade_source_documents (instrument_id, removed_at, published_at);

CREATE TABLE trade_alert_rules (
    id                 text COLLATE "C" PRIMARY KEY,                       -- alr_<ULID>
    owner_subject      text COLLATE "C" NOT NULL,
    instrument_id      text COLLATE "C" NOT NULL REFERENCES trade_instruments(id),
    kind               text COLLATE "C" NOT NULL CHECK (kind IN ('threshold','filing_type','new_document')),
    metric             text COLLATE "C",
    operator           text COLLATE "C" CHECK (operator IN ('above','below')),
    threshold          text COLLATE "C",
    threshold_num      double precision,
    unit               text COLLATE "C",
    currency           text COLLATE "C",
    form_types         text COLLATE "C",                                   -- JSON array (filing_type rules)
    armed              bigint NOT NULL DEFAULT 1,             -- threshold rules fire on a crossing, then re-arm
    last_observed_at   bigint,                                -- newest observation a threshold rule evaluated
    status             text COLLATE "C" NOT NULL DEFAULT 'active' CHECK (status IN ('active','deleted')),
    created_at         bigint NOT NULL,
    updated_at         bigint NOT NULL,
    CHECK (kind <> 'threshold' OR (metric IS NOT NULL AND operator IS NOT NULL AND threshold IS NOT NULL AND unit IS NOT NULL)),
    CHECK (kind <> 'filing_type' OR form_types IS NOT NULL)
);
CREATE INDEX trade_rules_owner ON trade_alert_rules (owner_subject, status);
CREATE INDEX trade_rules_instrument ON trade_alert_rules (instrument_id, status, kind);

CREATE TABLE trade_alert_deliveries (
    id             text COLLATE "C" PRIMARY KEY,                           -- ald_<ULID>
    rule_id        text COLLATE "C" NOT NULL REFERENCES trade_alert_rules(id),
    owner_subject  text COLLATE "C" NOT NULL,
    trigger_kind   text COLLATE "C" NOT NULL CHECK (trigger_kind IN ('observation','document')),
    trigger_id     text COLLATE "C" NOT NULL,
    event_id       text COLLATE "C",                                       -- the trade.alert.triggered envelope
    summary        text COLLATE "C" NOT NULL,                              -- JSON snapshot of what triggered it
    created_at     bigint NOT NULL,
    UNIQUE (rule_id, trigger_kind, trigger_id)
);
CREATE INDEX trade_deliveries_owner ON trade_alert_deliveries (owner_subject, created_at);

-- Freshness of each source Trade shows data from (not a charter table; a projection of Sources'
-- health plus Trade's own clock).
CREATE TABLE trade_source_status (
    source_key        text COLLATE "C" PRIMARY KEY,
    name              text COLLATE "C",
    upstream_status   text COLLATE "C",                                    -- Sources' health status, NULL = never reported
    last_success_at   bigint,                                 -- last successful fetch (Sources, or the newest retrieval Trade recorded)
    stale_after_sec   bigint,
    reported_at       bigint,                                 -- when Sources last told us about it
    stale             bigint NOT NULL DEFAULT 1,              -- as of the last evaluation
    stale_since       bigint,
    evaluated_at      bigint,
    terms_note        text COLLATE "C",
    license_note      text COLLATE "C"
);

CREATE TABLE trade_sync_state (
    name          text COLLATE "C" PRIMARY KEY,
    cursor        bigint NOT NULL DEFAULT 0,
    last_ok_at    bigint,
    last_error    text COLLATE "C",
    last_error_at bigint,
    counts        text COLLATE "C" NOT NULL DEFAULT '{}'
);

-- openvibe-publishing/revisions (prefix trade_context)
CREATE TABLE IF NOT EXISTS trade_context_revisions (
    id            text PRIMARY KEY,
    entity_id     text COLLATE "C" NOT NULL,
    number        integer NOT NULL CHECK (number >= 1),
    parent_id     text,
    parent_number integer,
    kind          text NOT NULL CHECK (kind IN ('edit','revert','import')),
    reverted_to   integer,
    content       text NOT NULL,
    fields        jsonb NOT NULL DEFAULT '{}',
    meta          jsonb NOT NULL DEFAULT '{}',
    content_hash  text NOT NULL,
    author        text,
    message       text,
    created_at    bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS trade_context_revisions_entity_num ON trade_context_revisions (entity_id, number);
CREATE TABLE IF NOT EXISTS trade_context_drafts (
    entity_id     text COLLATE "C" NOT NULL,
    owner         text COLLATE "C" NOT NULL,
    base_revision integer NOT NULL,
    content       text NOT NULL,
    fields        jsonb NOT NULL DEFAULT '{}',
    meta          jsonb NOT NULL DEFAULT '{}',
    created_at    bigint NOT NULL,
    updated_at    bigint NOT NULL,
    PRIMARY KEY (entity_id, owner)
);
CREATE INDEX IF NOT EXISTS trade_context_drafts_updated ON trade_context_drafts (entity_id, updated_at DESC, owner);
CREATE TABLE IF NOT EXISTS trade_context_revision_purges (
    entity_id   text COLLATE "C" PRIMARY KEY,
    reason      text NOT NULL,
    purged_by   text,
    purged_at   bigint NOT NULL
);
CREATE OR REPLACE FUNCTION trade_context_revisions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'trade_context_revisions rows are immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM trade_context_revision_purges WHERE entity_id = OLD.entity_id) THEN
        RAISE EXCEPTION 'trade_context_revisions rows are never deleted outside a recorded purge' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
END
$$;
CREATE OR REPLACE TRIGGER trade_context_revisions_no_update BEFORE UPDATE ON trade_context_revisions FOR EACH ROW EXECUTE FUNCTION trade_context_revisions_guard();
CREATE OR REPLACE TRIGGER trade_context_revisions_no_delete BEFORE DELETE ON trade_context_revisions FOR EACH ROW EXECUTE FUNCTION trade_context_revisions_guard();

-- openvibe-publishing/authorship (prefix trade_context)
CREATE TABLE IF NOT EXISTS trade_context_reviews (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entity_id   text COLLATE "C" NOT NULL,
    revision    integer NOT NULL,
    reviewer    text NOT NULL,
    decision    text NOT NULL CHECK (decision IN ('approved','rejected')),
    note        text,
    reviewed_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS trade_context_reviews_rev ON trade_context_reviews (entity_id, revision, id);
CREATE INDEX IF NOT EXISTS trade_context_reviews_entity ON trade_context_reviews (entity_id, id);
CREATE OR REPLACE FUNCTION trade_context_reviews_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'trade_context_reviews rows are immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
END
$$;
CREATE OR REPLACE TRIGGER trade_context_reviews_no_update BEFORE UPDATE ON trade_context_reviews FOR EACH ROW EXECUTE FUNCTION trade_context_reviews_guard();

-- openvibe-publishing/index-hooks (prefix trade)
CREATE TABLE IF NOT EXISTS trade_index_revisions (
    owner      text COLLATE "C" NOT NULL,
    type       text COLLATE "C" NOT NULL,
    id         text COLLATE "C" NOT NULL,
    revision   integer NOT NULL,
    hash       text NOT NULL,
    updated_at bigint NOT NULL,
    PRIMARY KEY (owner, type, id)
);

-- openvibe-sdk/events inbox: one receipt per (consumer, event) handled
CREATE TABLE IF NOT EXISTS idempotency_receipts (
    consumer     text NOT NULL,
    event_id     text NOT NULL,
    processed_at bigint NOT NULL,
    PRIMARY KEY (consumer, event_id)
);

-- openvibe-sdk/events PostgreSQL outbox
CREATE TABLE IF NOT EXISTS event_outbox (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id        text NOT NULL UNIQUE,
    envelope        jsonb NOT NULL,
    traceparent     text,
    created_at      bigint NOT NULL,
    attempts        integer NOT NULL DEFAULT 0,
    next_attempt_at bigint NOT NULL DEFAULT 0,
    sent_at         bigint,
    seq             bigint,
    rejected_at     bigint,
    last_error      text
);
CREATE INDEX IF NOT EXISTS event_outbox_due ON event_outbox (next_attempt_at, id) WHERE sent_at IS NULL AND rejected_at IS NULL;
CREATE INDEX IF NOT EXISTS event_outbox_sent ON event_outbox (sent_at) WHERE sent_at IS NOT NULL;
