-- phase: expand
-- AI market context (server/domain/briefs.js, facts.js): a company's key numbers are read from SEC's XBRL company facts
-- when it files a report (trade_facts_state: when, and whether it worked), and OpenVibe.AI writes a short brief from
-- those numbers and the filings list. A brief cites Trade's own observations and documents and is shown labelled as
-- AI-written and not reviewed by a person; editor-reviewed context (trade_context_revisions) is separate.
CREATE TABLE IF NOT EXISTS trade_facts_state (
    instrument_id text COLLATE "C" PRIMARY KEY REFERENCES trade_instruments(id),
    fetched_at    bigint NOT NULL,
    ok            bigint NOT NULL,
    error         text,
    observations  bigint NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS trade_ai_briefs (
    id            text COLLATE "C" PRIMARY KEY,                     -- tbr_<ULID>
    instrument_id text COLLATE "C" NOT NULL REFERENCES trade_instruments(id),
    summary       text NOT NULL,
    points        jsonb NOT NULL DEFAULT '[]',                      -- [{ text, observed_at, cites: [{ kind, id }] }]
    cites         jsonb NOT NULL DEFAULT '[]',                      -- [{ kind: document|observation, id }]
    gaps          jsonb NOT NULL DEFAULT '[]',
    as_of         bigint,                                           -- the newest observation or document time it cites
    inputs_hash   text NOT NULL,                                    -- what it was written from: same inputs, no new brief
    run_id        text,
    model         text,
    trigger       text NOT NULL CHECK (trigger IN ('report', 'reader')),
    created_at    bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS trade_ai_briefs_latest ON trade_ai_briefs (instrument_id, created_at DESC);
CREATE INDEX IF NOT EXISTS trade_ai_briefs_recent ON trade_ai_briefs (created_at DESC);
