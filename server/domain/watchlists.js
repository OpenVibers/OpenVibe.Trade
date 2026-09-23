'use strict';

/**
 * Watchlists: private per subject (usr_…). Only the owner (or a service acting for the owner with
 * X-OV-Subject and a trade.watchlist.* capability) can read or change one; anyone else gets 404, so
 * a watchlist's existence is never disclosed. Watchlists are never in a sitemap, a feed, Search or
 * an event, and every response that shows one is Cache-Control: private, no-store.
 */
const { ApiError } = require('../http/errors');
const { newId, iso, str } = require('./util');

function createWatchlists({ store, config, ctx }) {
    const { db } = store;
    const q = {
        byId: db.prepare('SELECT * FROM trade_watchlists WHERE id = ?'),
        forOwner: db.prepare('SELECT * FROM trade_watchlists WHERE owner_subject = ? ORDER BY name'),
        count: db.prepare('SELECT COUNT(*) AS n FROM trade_watchlists WHERE owner_subject = ?'),
        insert: db.prepare('INSERT INTO trade_watchlists (id, owner_subject, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'),
        rename: db.prepare('UPDATE trade_watchlists SET name = ?, updated_at = ? WHERE id = ?'),
        remove: db.prepare('DELETE FROM trade_watchlists WHERE id = ?'),
        items: db.prepare(`SELECT w.*, i.symbol, i.name, i.kind, i.exchange, i.status FROM trade_watchlist_items w
                           JOIN trade_instruments i ON i.id = w.instrument_id WHERE w.watchlist_id = ? ORDER BY i.symbol`),
        itemCount: db.prepare('SELECT COUNT(*) AS n FROM trade_watchlist_items WHERE watchlist_id = ?'),
        addItem: db.prepare('INSERT OR IGNORE INTO trade_watchlist_items (watchlist_id, instrument_id, note, added_at) VALUES (?, ?, ?, ?)'),
        removeItem: db.prepare('DELETE FROM trade_watchlist_items WHERE watchlist_id = ? AND instrument_id = ?'),
        touch: db.prepare('UPDATE trade_watchlists SET updated_at = ? WHERE id = ?'),
    };

    const unique = (fn) => {
        try { return fn(); } catch (err) {
            if (err && /UNIQUE constraint failed: trade_watchlists/.test(err.message)) throw new ApiError(409, 'watchlist.name_taken', 'You already have a watchlist with this name');
            throw err;
        }
    };

    const api = {
        /** The owner's watchlist, or 404 for anyone else (existence is not disclosed). */
        mustOwn(subject, id) {
            const w = q.byId.get(String(id || ''));
            if (!w || !subject || w.owner_subject !== subject) throw new ApiError(404, 'watchlist.not_found', 'No such watchlist');
            return w;
        },
        forOwner: (subject) => (subject ? q.forOwner.all(subject) : []),
        items: (w) => q.items.all(w.id),

        create(subject, input) {
            if (!subject) throw new ApiError(403, 'subject.required', 'Watchlists belong to a person');
            const name = str(input.name, 80, 'name', { required: true });
            if (q.count.get(subject).n >= config.limits.watchlistsPerSubject) throw new ApiError(429, 'watchlist.limit', `At most ${config.limits.watchlistsPerSubject} watchlists`);
            const id = newId('wl', store.now());
            unique(() => q.insert.run(id, subject, name, store.now(), store.now()));
            return q.byId.get(id);
        },

        rename(w, input) {
            const name = str(input.name, 80, 'name', { required: true });
            unique(() => q.rename.run(name, store.now(), w.id));
            return q.byId.get(w.id);
        },

        remove(w) { return store.tx(() => { db.prepare('DELETE FROM trade_watchlist_items WHERE watchlist_id = ?').run(w.id); return q.remove.run(w.id).changes > 0; }); },

        add(w, instrument, note = null) {
            if (!instrument) throw new ApiError(404, 'instrument.not_found', 'No such instrument');
            if (q.itemCount.get(w.id).n >= config.limits.itemsPerWatchlist) throw new ApiError(429, 'watchlist.full', `At most ${config.limits.itemsPerWatchlist} instruments per watchlist`);
            const added = q.addItem.run(w.id, instrument.id, str(note, 300, 'note'), store.now()).changes > 0;
            if (added) q.touch.run(store.now(), w.id);
            return added;
        },

        drop(w, instrument) {
            if (!instrument) return false;
            const removed = q.removeItem.run(w.id, instrument.id).changes > 0;
            if (removed) q.touch.run(store.now(), w.id);
            return removed;
        },

        dto(w, { withItems = true } = {}) {
            const out = { id: w.id, name: w.name, created_at: iso(w.created_at), updated_at: iso(w.updated_at) };
            if (withItems) {
                out.items = q.items.all(w.id).map((it) => ({
                    instrument: { id: it.instrument_id, symbol: it.symbol, name: it.name, kind: it.kind, exchange: it.exchange, status: it.status, url: ctx.urls.instrument({ symbol: it.symbol }) },
                    note: it.note, added_at: iso(it.added_at),
                }));
            }
            return out;
        },
    };
    return api;
}

module.exports = { createWatchlists };
