#!/usr/bin/env node
'use strict';

/**
 * scripts/rewind-sync-cursor.js — move Trade's Sources change cursor back so the sync re-reads items
 * that were advanced past without being stored.
 *
 * The bug this recovers from: the mapper understood only the explicit `fields.metric/value/unit/
 * observed_at` contract, so every item of Trade's real sources (SEC filings, frankfurter and ECB
 * rates) was skipped. Skips still advance the cursor (openvibe-publishing/ingest `pullChanges` moves
 * it past every committed page), so after the fix the cursor sits past the whole feed and the sync
 * would read nothing. Rewinding makes the sync pull it again.
 *
 * Re-reading is safe: apply() is idempotent per (Sources item id, revision) — a document is
 * upserted on its item id, an observation is keyed by (source_key, source_ref) and a replay answers
 * `created:false` — so a rewind through already-stored items changes nothing and emits no duplicate
 * events. The same script is therefore safe to re-run.
 *
 * DRY-RUN BY DEFAULT — it prints the current and target cursor and writes nothing. Pass --apply to
 * move the cursor. The running service's next sync tick (TRADE_SYNC_INTERVAL_MS, default 60 s)
 * picks up the rewound cursor; no restart is needed.
 *
 * Usage:
 *   node scripts/rewind-sync-cursor.js                 # dry run: show what would change
 *   node scripts/rewind-sync-cursor.js --apply         # set the cursor to 0 (the start of the feed)
 *   node scripts/rewind-sync-cursor.js --to 1200 --apply   # rewind to a specific change_seq
 */

const { load } = require('../server/config');
const { openStore } = require('../server/db');

const CURSOR = 'sources.trade';   // domain/ingest.js CURSOR — the Sources feed's row in trade_ingest_cursor

/** Read a `--name <value>` option from argv (undefined when absent). */
function option(name, argv = process.argv) {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
}

async function rewind(store, { to, apply, log = console } = {}) {
    const current = (await store.db.prepare('SELECT cursor FROM trade_ingest_cursor WHERE name = ?').get(CURSOR) || {}).cursor;
    const now = store.now();
    log.log(`[Trade rewind] cursor ${CURSOR}: ${current == null ? '(no row — the feed starts at 0)' : current} → ${to}`);
    if (current === to) {
        log.log('[Trade rewind] already at the target; nothing to do');
        return { current: current == null ? null : current, to, changed: false };
    }
    if (!apply) {
        log.log('[Trade rewind] dry run — not writing. Re-run with --apply to move the cursor.');
        return { current: current == null ? null : current, to, changed: false, dryRun: true };
    }
    await store.db.prepare(`INSERT INTO trade_ingest_cursor (name, cursor, updated_at) VALUES (?, ?, ?)
                            ON CONFLICT (name) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`).run(CURSOR, to, now);
    log.log(`[Trade rewind] cursor moved to ${to}; the next sync tick re-reads from there (idempotent)`);
    return { current: current == null ? null : current, to, changed: true };
}

async function main() {
    const config = load();
    const log = console;
    const apply = process.argv.includes('--apply');
    const toRaw = option('to');
    const to = toRaw === undefined ? 0 : Math.floor(Number(toRaw));
    if (!Number.isInteger(to) || to < 0) throw new Error('--to must be a non-negative integer');

    const store = await openStore(config, { log });
    try {
        await rewind(store, { to, apply, log });
    } finally {
        await store.close();
    }
}

if (require.main === module) {
    main().catch((err) => {
        console.error('[Trade rewind] failed:', err.message);
        process.exit(1);
    });
}

module.exports = { rewind, CURSOR };
