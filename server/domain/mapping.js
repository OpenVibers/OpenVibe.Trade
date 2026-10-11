'use strict';

/**
 * From an OpenVibe.Sources item (sources.item@1, category trade) to what Trade records. Pure and
 * deterministic; it reads only what the item states and never fills a gap.
 *
 *   observation   the item states a value, in one of three shapes:
 *                 - the explicit contract: fields { metric, value, unit, observed_at } plus a
 *                   symbol/ticker or CIK (currency, period, max_age_sec optional);
 *                 - a structured rate (the Sources api adapter, e.g. frankfurter-eur-rates):
 *                   fields.rate with fields.base and a quote currency (fields.quote/target_currency,
 *                   else the item's identity, which the adapter sets to the quote);
 *                 - a reference-rate article (the ECB feed): a "<rate> <QUOTE> = 1 <BASE> …" title,
 *                   the value and currencies read from that stated title.
 *                 An item without its own observation time is skipped — the retrieval time is NOT an
 *                 observation time. A bare date the source states (YYYY-MM-DD) is that day, 00:00 UTC.
 *   document      an SEC EDGAR filing: the canonical URL is under
 *                 sec.gov/Archives/edgar/data/<CIK>/<accession>/ (the xbrlrss feed's index links),
 *                 so the CIK and accession number come from the URL; the form type is the item's
 *                 summary when it looks like a form type (the feed's <description>, e.g. "10-Q"),
 *                 else fields.form_type; the filer is the item title.
 *                 Any other item with fields.cik or fields.symbol/ticker is a document too
 *                 (kind 'record' for record items, else 'article').
 *   skip          everything else, with a reason (counted in the sync state, never guessed at).
 */
const { parseTime, parseDecimal, iso } = require('./helpers');

const SEC_PATH_RE = /^https?:\/\/(?:www\.)?sec\.gov\/Archives\/edgar\/data\/(\d{1,10})\/(\d{18})(?:\/|$)/i;
const FORM_RE = /^[A-Z0-9][A-Z0-9 \-/.]{0,19}$/;
// "1.1206 USD = 1 EUR 2026-10-09 ECB Reference rate" → rate, quote, base, read as stated.
const RATE_TITLE_RE = /^\s*(\d{1,20}(?:\.\d{1,12})?)\s+([A-Z]{3})\s*=\s*1\s+([A-Z]{3})(?:\s|$)/;
const BARE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function formType(v) {
    if (typeof v !== 'string') return null;
    const s = v.trim().toUpperCase();
    return FORM_RE.test(s) && /\d|^[A-Z]{1,6}(\/A)?$/.test(s) ? s : null;
}

function accessionOf(digits) {
    return `${digits.slice(0, 10)}-${digits.slice(10, 12)}-${digits.slice(12)}`;
}

function filerName(title) {
    if (typeof title !== 'string') return null;
    const s = title.replace(/\s*\(\d{10}\)\s*(\((Filer|Subject|Reporting|Filed by)[^)]*\))?\s*$/i, '').trim();
    return s || null;
}

/** A scalar as a trimmed string, or null. */
function str1(v) { return v == null || v === '' ? null : (String(v).trim() || null); }

/** A ticker-like identity ("USD"): upper-case it, else null (a URL or guid is not an instrument key). */
function tickerish(v) {
    return typeof v === 'string' && /^[A-Za-z][A-Za-z0-9.-]{0,15}$/.test(v.trim()) ? v.trim().toUpperCase() : null;
}

/** A time the source states: a full date-time with a zone, or a bare date (→ that day, 00:00 UTC). */
function statedTime(v) {
    const t = parseTime(v);
    if (t != null) return t;
    if (typeof v === 'string' && BARE_DATE_RE.test(v.trim())) {
        const d = Date.parse(`${v.trim()}T00:00:00Z`);
        return Number.isFinite(d) ? d : null;
    }
    return null;
}

/**
 * The observation an item states, or null: the explicit contract, a structured `fields.rate`, or a
 * reference-rate title. `symbol` is the instrument key the item itself names (the quote currency for
 * a rate). Nothing here is invented — a missing field means this shape does not apply.
 */
function statedObservation(item, f) {
    if (item.kind === 'observation' || (f.metric != null && f.value != null)) {
        return { metric: f.metric, value: f.value, unit: f.unit, currency: f.currency == null ? null : f.currency,
            period: f.period, observed_at: f.observed_at, max_age_sec: f.max_age_sec, symbol: null };
    }
    if (f.rate != null) {
        const quote = str1(f.quote) || str1(f.target_currency) || str1(f.symbol) || str1(f.ticker) || tickerish(item.identity);
        const base = str1(f.base) || str1(f.base_currency);
        if (!quote || !base) return null;
        return { metric: 'rate', value: f.rate, unit: quote, currency: quote, period: null,
            observed_at: f.observed_at != null ? f.observed_at : f.date, max_age_sec: f.max_age_sec, symbol: quote };
    }
    const m = RATE_TITLE_RE.exec(String(item.title || ''));
    if (m) {
        return { metric: 'rate', value: m[1], unit: m[2], currency: m[2], period: null,
            observed_at: f.observed_at != null ? f.observed_at : item.published_at, max_age_sec: f.max_age_sec, symbol: m[2] };
    }
    return null;
}

/** → { type: 'observation', keys, observation } | { type: 'document', keys, document } | { type: 'skip', reason } */
function mapItem(item) {
    if (!item || typeof item !== 'object' || !item.id) return { type: 'skip', reason: 'malformed_item' };
    const f = item.fields && typeof item.fields === 'object' ? item.fields : {};
    const keys = {
        cik: f.cik != null ? String(f.cik) : null,
        symbol: f.symbol != null ? String(f.symbol) : (f.ticker != null ? String(f.ticker) : null),
    };
    const prov = item.provenance || {};
    const retrievedAt = parseTime(prov.retrieved_at);
    if (retrievedAt == null) return { type: 'skip', reason: 'no_retrieval_time' };

    const obs = statedObservation(item, f);
    if (obs) {
        const symbol = obs.symbol || keys.symbol;
        if (!keys.cik && !symbol) return { type: 'skip', reason: 'no_instrument_key' };
        if (obs.metric == null || obs.unit == null || !parseDecimal(obs.value)) return { type: 'skip', reason: 'incomplete_observation' };
        const observedAt = statedTime(obs.observed_at);
        if (observedAt == null) return { type: 'skip', reason: 'no_observation_time' };
        return {
            type: 'observation', keys: { cik: keys.cik, symbol },
            observation: {
                metric: obs.metric, value: obs.value, unit: obs.unit, currency: obs.currency == null ? null : obs.currency,
                period: obs.period == null ? null : String(obs.period), observed_at: iso(observedAt), retrieved_at: prov.retrieved_at,
                source_key: item.source_key, source_item_id: item.id, source_url: item.canonical_url || null,
                source_ref: `${item.id}#r${item.revision}:${obs.metric}`, max_age_sec: obs.max_age_sec == null ? null : obs.max_age_sec,
            },
        };
    }

    const base = {
        source_key: item.source_key, source_item_id: item.id, source_revision: item.revision,
        title: item.title || null, url: item.canonical_url || null,
        published_at: parseTime(item.published_at), source_updated_at: parseTime(item.source_updated_at),
        retrieved_at: retrievedAt, first_seen_at: parseTime(prov.first_seen_at) || retrievedAt,
        license_note: prov.license_note || null, terms_note: prov.terms_note || null,
    };
    const sec = item.canonical_url ? SEC_PATH_RE.exec(item.canonical_url) : null;
    if (sec) {
        const cik = sec[1].padStart(10, '0');
        return {
            type: 'document', keys: { cik, symbol: keys.symbol },
            document: { ...base, kind: 'filing', form_type: formType(item.summary) || formType(f.form_type), filer_name: filerName(item.title), cik, accession: accessionOf(sec[2]) },
        };
    }
    if (keys.cik || keys.symbol) {
        return {
            type: 'document', keys,
            document: { ...base, kind: item.kind === 'record' ? 'record' : 'article', form_type: formType(f.form_type), filer_name: null, cik: keys.cik ? keys.cik.replace(/^CIK/i, '').padStart(10, '0') : null, accession: null },
        };
    }
    return { type: 'skip', reason: 'no_instrument_key' };
}

module.exports = { mapItem, formType, filerName, accessionOf, statedTime };
