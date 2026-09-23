'use strict';

/**
 * Source documents (filings and other documents) linked from OpenVibe.Sources items. Sources owns
 * the item; Trade keeps the metadata it shows (form type, filer, dates, URL, provenance) keyed by
 * the item id, follows the item's revisions, and hides the document when Sources removes the item
 * (takedown or licence), keeping the row as the record that it happened.
 *
 * A newly seen document is what new_document and filing_type alert rules trigger on (once per rule
 * and document: alerts.onDocument). Item revisions update the row and never trigger again.
 */
const { newId, iso } = require('./util');

function createDocuments({ store, ctx }) {
    const { db } = store;
    const q = {
        byItem: db.prepare('SELECT * FROM trade_source_documents WHERE source_item_id = ?'),
        byId: db.prepare('SELECT * FROM trade_source_documents WHERE id = ?'),
        insert: db.prepare(`INSERT INTO trade_source_documents (id, instrument_id, source_key, source_item_id, source_revision, kind, form_type, title, filer_name,
                            cik, accession, url, published_at, source_updated_at, retrieved_at, first_seen_at, license_note, terms_note, recorded_at, updated_at)
                            VALUES (@id, @instrument_id, @source_key, @source_item_id, @source_revision, @kind, @form_type, @title, @filer_name,
                            @cik, @accession, @url, @published_at, @source_updated_at, @retrieved_at, @first_seen_at, @license_note, @terms_note, @now, @now)`),
        revise: db.prepare(`UPDATE trade_source_documents SET source_revision = @source_revision, form_type = @form_type, title = @title, filer_name = @filer_name,
                            url = @url, published_at = @published_at, source_updated_at = @source_updated_at, retrieved_at = @retrieved_at,
                            license_note = @license_note, terms_note = @terms_note, updated_at = @now WHERE id = @id`),
        touch: db.prepare('UPDATE trade_source_documents SET retrieved_at = @retrieved_at, updated_at = @now WHERE id = @id AND retrieved_at < @retrieved_at'),
        remove: db.prepare('UPDATE trade_source_documents SET removed_at = @at, removed_reason = @reason, updated_at = @now WHERE id = @id AND removed_at IS NULL'),
        forInstrument: db.prepare(`SELECT * FROM trade_source_documents WHERE instrument_id = ? AND removed_at IS NULL
                                   ORDER BY COALESCE(published_at, first_seen_at) DESC, id DESC LIMIT ? OFFSET ?`),
        countFor: db.prepare('SELECT COUNT(*) AS n FROM trade_source_documents WHERE instrument_id = ? AND removed_at IS NULL'),
        recent: db.prepare(`SELECT d.* FROM trade_source_documents d JOIN trade_instruments i ON i.id = d.instrument_id
                            WHERE d.removed_at IS NULL AND i.status = 'active' ORDER BY COALESCE(d.published_at, d.first_seen_at) DESC, d.id DESC LIMIT ?`),
    };

    const api = {
        get: (id) => q.byId.get(id) || null,
        byItem: (itemId) => q.byItem.get(itemId) || null,
        forInstrument: (instrument, { limit = 50, offset = 0 } = {}) => q.forInstrument.all(instrument.id, limit, offset),
        count: (instrument) => q.countFor.get(instrument.id).n,
        recent: (limit = 50) => q.recent.all(limit),

        /** From a mapped Sources item (domain/mapping.js). → { document, created, changed } */
        upsert(doc, instrument, { traceparent } = {}) {
            return store.tx(() => {
                const existing = q.byItem.get(doc.source_item_id);
                if (existing) {
                    if (existing.instrument_id !== instrument.id) return { document: existing, created: false, changed: false };
                    if (doc.source_revision > existing.source_revision) {
                        q.revise.run({ ...doc, id: existing.id, now: store.now() });
                    } else {
                        q.touch.run({ id: existing.id, retrieved_at: doc.retrieved_at, now: store.now() });
                    }
                    ctx.freshness.noteRetrieval(doc.source_key, doc.retrieved_at);
                    return { document: q.byId.get(existing.id), created: false, changed: doc.source_revision > existing.source_revision };
                }
                const id = newId('doc', store.now());
                q.insert.run({ ...doc, id, instrument_id: instrument.id, now: store.now() });
                const row = q.byId.get(id);
                ctx.freshness.noteRetrieval(doc.source_key, doc.retrieved_at);
                ctx.alerts.onDocument(row, instrument, { traceparent });
                return { document: row, created: true, changed: true };
            });
        },

        /** Sources removed the item: hide the document (the row stays as the record). */
        remove(itemId, { at, reason }) {
            const row = q.byItem.get(itemId);
            if (!row) return false;
            return q.remove.run({ id: row.id, at: at || store.now(), reason: String(reason || 'removed at the source').slice(0, 500), now: store.now() }).changes > 0;
        },

        dto(d) {
            return {
                id: d.id, kind: d.kind, form_type: d.form_type, title: d.title, filer_name: d.filer_name, cik: d.cik, accession: d.accession, url: d.url,
                published_at: iso(d.published_at), source_updated_at: iso(d.source_updated_at), retrieved_at: iso(d.retrieved_at), first_seen_at: iso(d.first_seen_at),
                source: { key: d.source_key, item_id: d.source_item_id, revision: d.source_revision, license_note: d.license_note, terms_note: d.terms_note },
            };
        },
    };
    return api;
}

module.exports = { createDocuments };
