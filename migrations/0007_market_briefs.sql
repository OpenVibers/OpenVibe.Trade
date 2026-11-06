-- phase: expand
-- A market-wide AI brief (server/domain/market-briefs.js): one a day at most, written by OpenVibe.AI from what Trade
-- already holds — the day's filings by form, the euro reference rates, the companies with new filings or SEC figures,
-- and aggregate watchlist activity. It cites Trade's own pages and keeps the home page noindex until a person
-- reviews it; reviews are append-only, like trade_context_reviews.
CREATE TABLE IF NOT EXISTS trade_market_briefs (
    id            text COLLATE "C" PRIMARY KEY,                     -- tmk_<ULID>
    brief_date    text COLLATE "C" NOT NULL UNIQUE,                 -- the UTC day it covers, YYYY-MM-DD: at most one a day
    summary       text NOT NULL,
    points        jsonb NOT NULL DEFAULT '[]',                      -- [{ text, cites: [{ url, label }] }]
    cites         jsonb NOT NULL DEFAULT '[]',                      -- [{ url, label }] every page the brief rests on
    gaps          jsonb NOT NULL DEFAULT '[]',
    as_of         bigint,                                           -- the newest cited row's time
    inputs_hash   text NOT NULL,                                    -- what it was written from
    run_id        text,
    model         text,
    trigger       text NOT NULL DEFAULT 'schedule',
    created_at    bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS trade_market_briefs_day ON trade_market_briefs (brief_date DESC);

CREATE TABLE IF NOT EXISTS trade_market_brief_reviews (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    brief_id    text COLLATE "C" NOT NULL REFERENCES trade_market_briefs(id),
    reviewer    text NOT NULL,                                      -- usr_… only: a person, never a service or the AI
    decision    text NOT NULL CHECK (decision IN ('approved','rejected')),
    note        text,
    reviewed_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS trade_market_brief_reviews_brief ON trade_market_brief_reviews (brief_id, id);
CREATE OR REPLACE FUNCTION trade_market_brief_reviews_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'trade_market_brief_reviews rows are immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
END
$$;
CREATE OR REPLACE TRIGGER trade_market_brief_reviews_no_update BEFORE UPDATE ON trade_market_brief_reviews FOR EACH ROW EXECUTE FUNCTION trade_market_brief_reviews_guard();
