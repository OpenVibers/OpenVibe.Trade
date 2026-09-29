-- phase: expand
-- openvibe-publishing/ingest (prefix trade): the change cursor of the Sources feed, replacing the
-- cursor Trade kept in trade_sync_state before the chassis (T9). Additive.
CREATE TABLE IF NOT EXISTS trade_ingest_cursor (
    name       text COLLATE "C" NOT NULL,
    cursor     bigint NOT NULL,
    updated_at bigint NOT NULL,
    PRIMARY KEY (name)
);

-- One-time continuity: seed the chassis cursor from the row Trade already had, so the feed resumes
-- where it was instead of restarting at zero. A fresh database has no such row and starts at 0.
INSERT INTO trade_ingest_cursor (name, cursor, updated_at)
SELECT 'sources.trade', cursor, 0 FROM trade_sync_state WHERE name = 'sources.trade'
ON CONFLICT (name) DO NOTHING;
