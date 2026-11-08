-- phase: expand
-- The worker's AI briefs in the batch class (server/domain/briefs.js, server/clients/ai.js): a report brief is
-- queued at OpenVibe.AI instead of waited for, and the worker collects the answer on a later tick. The work item
-- keeps the pending run id and the exact inputs it was made from, so a restart loses nothing and the citations
-- written later still point at the rows the model saw.
CREATE TABLE IF NOT EXISTS trade_ai_brief_jobs (
    instrument_id text COLLATE "C" PRIMARY KEY REFERENCES trade_instruments(id),
    run_id        text COLLATE "C" NOT NULL,                    -- the OpenVibe.AI run id the worker polls
    inputs        jsonb NOT NULL,                               -- { input: <the exact workflow input>, refs: <citation refs> }
    inputs_hash   text NOT NULL,                                -- the same hash as trade_ai_briefs.inputs_hash
    status        text NOT NULL CHECK (status IN ('pending', 'fallback', 'done', 'failed')),
    attempts      bigint NOT NULL DEFAULT 1,                    -- 1 = batch; 2 = its one background fallback
    deadline_at   bigint NOT NULL,                              -- when the batch stops being worth waiting for
    created_at    bigint NOT NULL,
    updated_at    bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS trade_ai_brief_jobs_open ON trade_ai_brief_jobs (status, created_at);
-- One brief per run: a collected answer written twice is refused by the database, not only by the worker.
CREATE UNIQUE INDEX IF NOT EXISTS trade_ai_briefs_run ON trade_ai_briefs (run_id) WHERE run_id IS NOT NULL;
