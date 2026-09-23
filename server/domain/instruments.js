'use strict';

/**
 * Instruments and their aliases, with deterministic resolution.
 *
 * Normalisation (the key an alias is stored and looked up under):
 *   ticker  upper case, trimmed; A–Z, 0–9, '.', '-' only, 1–16 characters (BRK.B, RDS-A)
 *   cik     digits only ("CIK" prefix allowed), zero-padded to 10 (320193 → 0000320193)
 *   name    NFKD without diacritics, upper case, '&' → AND, dots and apostrophes removed (S.A. → SA),
 *           other punctuation → space, whitespace
 *           collapsed, a trailing SEC state marker (/DE/) dropped, then trailing corporate-form
 *           words (INC, CORP, CO, LTD, PLC, LLC, …, and a dangling AND from "& Co") dropped
 *
 * resolve(query, { kind }) tries, in this fixed order, and stops at the first rule that matches:
 *   1. CIK      when the query is all digits (optionally "CIK…"): the instrument's CIK or a cik alias
 *   2. ticker   the instrument's symbol, then a ticker alias
 *   3. name     name aliases; one instrument → resolved, several → ambiguous (candidates listed,
 *               none chosen), none → not_found
 * There is no fuzzy or prefix matching and no ranking: the same database answers the same query the
 * same way. A ticker or CIK names exactly one instrument (a unique index enforces it).
 */
const { ApiError } = require('../http/errors');
const { newId, invalid, str } = require('./util');

const KINDS = ['equity', 'fund', 'index', 'currency', 'commodity', 'crypto', 'other'];
const SYMBOL_RE = /^[A-Z0-9][A-Z0-9.-]{0,15}$/;
const CORPORATE_WORDS = new Set(['INC', 'INCORPORATED', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'LTD', 'LIMITED', 'PLC', 'LLC', 'LP', 'LLP', 'SA', 'AG', 'NV', 'SE', 'THE']);

function normSymbol(v) {
    if (v == null) return null;
    const s = String(v).trim().toUpperCase();
    return SYMBOL_RE.test(s) ? s : null;
}

function normCik(v) {
    if (v == null) return null;
    const s = String(v).trim().toUpperCase().replace(/^CIK/, '');
    return /^\d{1,10}$/.test(s) ? s.padStart(10, '0') : null;
}

function normName(v) {
    if (v == null) return null;
    let s = String(v).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
    s = s.replace(/&/g, ' AND ').replace(/\s*\/[A-Z]{2}\/\s*$/, ' ');
    s = s.replace(/[.'’]/g, '').replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
    const words = s.split(' ').filter(Boolean);
    while (words.length > 1 && (CORPORATE_WORDS.has(words[words.length - 1]) || words[words.length - 1] === 'AND')) words.pop();
    while (words.length > 1 && words[0] === 'THE') words.shift();
    const out = words.join(' ');
    return out || null;
}

const NORMALIZE = { ticker: normSymbol, cik: normCik, name: normName };

function createInstruments({ store }) {
    const { db } = store;
    const q = {
        byId: db.prepare('SELECT * FROM trade_instruments WHERE id = ?'),
        bySymbol: db.prepare('SELECT * FROM trade_instruments WHERE symbol = ?'),
        byCik: db.prepare('SELECT * FROM trade_instruments WHERE cik = ?'),
        alias: db.prepare('SELECT DISTINCT i.* FROM trade_instrument_aliases a JOIN trade_instruments i ON i.id = a.instrument_id WHERE a.kind = ? AND a.normalized = ? ORDER BY i.symbol'),
        aliasesOf: db.prepare('SELECT kind, value, normalized, created_at FROM trade_instrument_aliases WHERE instrument_id = ? ORDER BY kind, normalized'),
        insert: db.prepare(`INSERT INTO trade_instruments (id, symbol, name, kind, exchange, cik, currency, status, created_by, created_at, updated_at)
                            VALUES (@id, @symbol, @name, @kind, @exchange, @cik, @currency, 'active', @by, @now, @now)`),
        insertAlias: db.prepare(`INSERT OR IGNORE INTO trade_instrument_aliases (instrument_id, kind, value, normalized, added_by, created_at)
                                 VALUES (?, ?, ?, ?, ?, ?)`),
        count: db.prepare("SELECT COUNT(*) AS n FROM trade_instruments WHERE status = 'active'"),
        page: db.prepare("SELECT * FROM trade_instruments WHERE status = 'active' ORDER BY symbol LIMIT ? OFFSET ?"),
        active: db.prepare("SELECT * FROM trade_instruments WHERE status = 'active' ORDER BY symbol"),
    };

    function fields(input, { partial = false } = {}) {
        const out = {};
        if (!partial || input.name !== undefined) out.name = str(input.name, 200, 'name', { required: !partial });
        if (!partial || input.kind !== undefined) {
            const kind = input.kind == null || input.kind === '' ? (partial ? undefined : 'equity') : String(input.kind);
            if (kind !== undefined && !KINDS.includes(kind)) throw invalid(`kind must be one of ${KINDS.join(', ')}`);
            if (kind !== undefined) out.kind = kind;
        }
        if (!partial || input.exchange !== undefined) out.exchange = str(input.exchange, 40, 'exchange');
        if (!partial || input.cik !== undefined) {
            if (input.cik == null || input.cik === '') out.cik = null;
            else {
                out.cik = normCik(input.cik);
                if (!out.cik) throw invalid('cik must be up to 10 digits');
            }
        }
        if (!partial || input.currency !== undefined) {
            const c = input.currency == null || input.currency === '' ? null : String(input.currency).trim().toUpperCase();
            if (c && !/^[A-Z]{3}$/.test(c)) throw invalid('currency must be an ISO 4217 code like USD');
            out.currency = c;
        }
        return out;
    }

    function conflictGuard(fn) {
        try { return fn(); } catch (err) {
            if (err && /UNIQUE constraint failed/.test(err.message)) {
                if (/trade_instruments\.symbol/.test(err.message)) throw new ApiError(409, 'instrument.symbol_taken', 'Another instrument has this symbol');
                if (/trade_instruments\.cik/.test(err.message)) throw new ApiError(409, 'instrument.cik_taken', 'Another instrument has this CIK');
                throw new ApiError(409, 'alias.taken', 'This ticker or CIK already names another instrument');
            }
            throw err;
        }
    }

    const api = {
        KINDS,
        normSymbol, normCik, normName,

        get: (id) => q.byId.get(id) || null,
        bySymbol: (symbol) => { const s = normSymbol(symbol); return s ? q.bySymbol.get(s) || null : null; },
        aliases: (instrument) => q.aliasesOf.all(instrument.id),
        active: () => q.active.all(),
        page({ limit = 50, offset = 0 } = {}) {
            return { total: q.count.get().n, instruments: q.page.all(limit, offset) };
        },

        /** input: { symbol, name, kind?, exchange?, cik?, currency? } → the new row. Aliases for the symbol, CIK and name are added. */
        create(input, by) {
            const symbol = normSymbol(input.symbol);
            if (!symbol) throw invalid('symbol must be 1–16 characters of A–Z, 0–9, "." or "-"');
            const f = fields(input);
            const id = newId('ins', store.now());
            return conflictGuard(() => store.tx(() => {
                // A ticker alias of another instrument must not be shadowed by a new symbol.
                const holder = q.alias.all('ticker', symbol).find((i) => i.symbol !== symbol);
                if (holder) throw new ApiError(409, 'alias.taken', `${symbol} is already an alias of ${holder.symbol}`);
                q.insert.run({ id, symbol, ...f, by: by || null, now: store.now() });
                q.insertAlias.run(id, 'ticker', symbol, symbol, by || null, store.now());
                if (f.cik) q.insertAlias.run(id, 'cik', f.cik, f.cik, by || null, store.now());
                const n = normName(f.name);
                if (n) q.insertAlias.run(id, 'name', f.name, n, by || null, store.now());
                return q.byId.get(id);
            }));
        },

        update(instrument, input) {
            const f = fields(input, { partial: true });
            if (input.status !== undefined) {
                if (!['active', 'archived'].includes(input.status)) throw invalid('status must be active or archived');
                f.status = input.status;
            }
            const keys = Object.keys(f);
            if (!keys.length) return instrument;
            return conflictGuard(() => store.tx(() => {
                db.prepare(`UPDATE trade_instruments SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @now WHERE id = @id`).run({ ...f, now: store.now(), id: instrument.id });
                if (f.cik) q.insertAlias.run(instrument.id, 'cik', f.cik, f.cik, null, store.now());
                if (f.name) { const n = normName(f.name); if (n) q.insertAlias.run(instrument.id, 'name', f.name, n, null, store.now()); }
                return q.byId.get(instrument.id);
            }));
        },

        addAlias(instrument, kind, value, by) {
            if (!NORMALIZE[kind]) throw invalid('alias kind must be ticker, cik or name');
            const raw = str(value, 200, 'alias', { required: true });
            const n = NORMALIZE[kind](raw);
            if (!n) throw invalid(`not a valid ${kind}`);
            if (kind === 'ticker') {
                const owner = q.bySymbol.get(n);
                if (owner && owner.id !== instrument.id) throw new ApiError(409, 'alias.taken', `${n} is the symbol of ${owner.symbol}`);
            }
            if (kind === 'cik') {
                const owner = q.byCik.get(n);
                if (owner && owner.id !== instrument.id) throw new ApiError(409, 'alias.taken', `${n} is the CIK of ${owner.symbol}`);
            }
            conflictGuard(() => q.insertAlias.run(instrument.id, kind, raw, n, by || null, store.now()));
            return { kind, value: raw, normalized: n };
        },

        /**
         * → { query, status: 'resolved'|'ambiguous'|'not_found', match: { kind, value } | null,
         *     instrument | null, candidates: [] }
         */
        resolve(query, { kind = null } = {}) {
            const raw = String(query == null ? '' : query).trim().slice(0, 200);
            const out = (status, match, instrument, candidates = []) => ({ query: raw, status, match, instrument: instrument || null, candidates });
            if (!raw) return out('not_found', null, null);
            if (kind && !NORMALIZE[kind]) throw invalid('kind must be ticker, cik or name');

            if (!kind || kind === 'cik') {
                const cik = /^(CIK)?\d{1,10}$/i.test(raw) ? normCik(raw) : null;
                if (cik) {
                    const hit = q.byCik.get(cik) || q.alias.all('cik', cik)[0];
                    if (hit) return out('resolved', { kind: 'cik', value: cik }, hit);
                }
            }
            if (!kind || kind === 'ticker') {
                const sym = normSymbol(raw);
                if (sym) {
                    const hit = q.bySymbol.get(sym);
                    if (hit) return out('resolved', { kind: 'symbol', value: sym }, hit);
                    const alias = q.alias.all('ticker', sym)[0];
                    if (alias) return out('resolved', { kind: 'ticker', value: sym }, alias);
                }
            }
            if (!kind || kind === 'name') {
                const n = normName(raw);
                if (n) {
                    const hits = q.alias.all('name', n);
                    if (hits.length === 1) return out('resolved', { kind: 'name', value: n }, hits[0]);
                    if (hits.length > 1) return out('ambiguous', { kind: 'name', value: n }, null, hits);
                }
            }
            return out('not_found', null, null);
        },
    };
    return api;
}

module.exports = { createInstruments, normSymbol, normCik, normName, KINDS };
