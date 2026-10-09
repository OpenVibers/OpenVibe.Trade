'use strict';

/**
 * Account export and deletion → Trade (ADR-033; openvibe-sdk/account-data). What Trade holds about a person:
 *
 *   their own, deleted whole       watchlists (their items go with them, ON DELETE CASCADE), alert rules and the
 *                                  deliveries under them, and unsaved context drafts
 *   contributed, made authorless   instruments and aliases they added, context revisions they wrote (the author
 *                                  column and their id in meta.authorship.authors), observations they recorded by hand
 *                                  (recorded_by is NOT NULL, so it becomes 'deleted'), and purges they ran
 *   kept                           context reviews: an approval by a person is what lets reviewed text stay published
 *                                  (openvibe-publishing/authorship), so a reviewer's record stays (counted as retained)
 *
 * No secret or other person's data is held in any of these tables.
 */
const { createAccountData, TOPICS } = require('openvibe-sdk/account-data');

const anonymize = { anonymize: {} };

const TABLES = [
    { table: 'trade_watchlists', subject: 'owner_subject', file: 'watchlists.json', columns: ['id', 'name', 'created_at', 'updated_at'] },
    // Deliveries reference their rule, so they go first.
    { table: 'trade_alert_deliveries', subject: 'owner_subject', file: 'alert-deliveries.json', columns: ['id', 'rule_id', 'trigger_kind', 'trigger_id', 'summary', 'created_at'] },
    { table: 'trade_alert_rules', subject: 'owner_subject', file: 'alert-rules.json', columns: ['id', 'instrument_id', 'kind', 'metric', 'operator', 'threshold', 'unit', 'currency', 'form_types', 'status', 'created_at', 'updated_at'] },
    { table: 'trade_context_drafts', subject: 'owner', file: 'context-drafts.json', columns: ['entity_id', 'base_revision', 'content', 'fields', 'created_at', 'updated_at'] },
    { table: 'trade_instruments', subject: 'created_by', file: 'instruments.json', columns: ['id', 'symbol', 'name', 'kind', 'exchange', 'currency', 'created_at'], erase: anonymize },
    { table: 'trade_instrument_aliases', subject: 'added_by', file: null, erase: anonymize },
    { table: 'trade_context_revision_purges', subject: 'purged_by', file: null, erase: anonymize },
    { table: 'trade_context_reviews', subject: 'reviewer', file: 'context-reviews.json', columns: ['entity_id', 'revision', 'decision', 'note', 'reviewed_at'], order: 'reviewed_at', erase: { keep: 'a person\'s approval is what lets reviewed text stay published' } },
];

/**
 * The watchlists' items (keyed by the list, not the person), the context revisions they wrote and the observations
 * they recorded by hand. Revisions and observations are append-only (database triggers), so they are erased in
 * extraErase under the trade.account_erasure setting (migrations/0004_account_erasure.sql), not by the table map.
 */
async function extraExport(db, subject) {
    const files = [];
    const revisions = await db.many(`SELECT entity_id, number, kind, content, fields, message, created_at FROM trade_context_revisions
        WHERE author = $1 ORDER BY created_at DESC LIMIT 5000`, [subject]);
    if (revisions.length) files.push({ name: 'context-revisions.json', content: revisions });
    const items = await db.many(`SELECT i.watchlist_id, i.instrument_id, i.note, i.added_at FROM trade_watchlist_items i
        JOIN trade_watchlists w ON w.id = i.watchlist_id WHERE w.owner_subject = $1 ORDER BY i.added_at DESC LIMIT 5000`, [subject]);
    if (items.length) files.push({ name: 'watchlist-items.json', content: items });
    const obs = await db.many(`SELECT id, instrument_id, metric, value, unit, currency, period, observed_at, source_key, source_url, recorded_at
        FROM trade_market_observations WHERE recorded_by = $1 ORDER BY recorded_at DESC LIMIT 5000`, [subject]);
    if (obs.length) files.push({ name: 'observations.json', content: obs });
    return files;
}

async function extraErase(t, subjects, counts) {
    // Only this transaction may take a person's id out of the append-only rows; the setting ends with it.
    await t.value("SELECT set_config('trade.account_erasure', 'on', true)");
    counts.add(counts.retained, 'tombstones', await t.exec(`UPDATE trade_context_revisions SET author = NULL
        WHERE author = ANY($1::text[])`, [subjects]));
    counts.add(counts.retained, 'tombstones', await t.exec(`UPDATE trade_market_observations SET recorded_by = 'deleted'
        WHERE recorded_by = ANY($1::text[])`, [subjects]));
    counts.add(counts.retained, 'tombstones', await t.exec(`UPDATE trade_context_revisions
        SET meta = jsonb_set(meta, '{authorship,authors}', COALESCE((SELECT jsonb_agg(a) FROM jsonb_array_elements(meta->'authorship'->'authors') a
            WHERE NOT ((a #>> '{}') = ANY($1::text[]))), '[]'::jsonb))
        WHERE jsonb_typeof(meta->'authorship'->'authors') = 'array' AND (meta->'authorship'->'authors') ?| $1::text[]`, [subjects]));
    await t.value("SELECT set_config('trade.account_erasure', 'off', true)");
}

/** The account-data handle for Trade's database (server/db.js, store.db). */
function create({ db, log = console } = {}) {
    return createAccountData({
        db, service: 'trade', tables: TABLES, extraExport, extraErase, log,
        note: 'Instruments, context text and observations you contributed stay without your name; reviews you approved stay attributed.',
    });
}

module.exports = { create, TABLES, TOPICS };
