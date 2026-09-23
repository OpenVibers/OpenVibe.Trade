'use strict';

/**
 * From an OpenVibe.Sources item (sources.item@1, category trade) to what Trade records. Pure and
 * deterministic; it reads only what the item states and never fills a gap.
 *
 *   observation   the item states a value: fields { metric, value, unit, observed_at } plus a
 *                 symbol/ticker or CIK (currency, period, max_age_sec optional). An item without its
 *                 own observation time is skipped — the retrieval time is NOT an observation time.
 *   document      an SEC EDGAR filing: the canonical URL is under
 *                 sec.gov/Archives/edgar/data/<CIK>/<accession>/ (the xbrlrss feed's index links),
 *                 so the CIK and accession number come from the URL; the form type is the item's
 *                 summary when it looks like a form type (the feed's <description>, e.g. "10-Q"),
 *                 else fields.form_type; the filer is the item title.
 *                 Any other item with fields.cik or fields.symbol/ticker is a document too
 *                 (kind 'record' for record items, else 'article').
 *   skip          everything else, with a reason (counted in the sync state, never guessed at).
 */
const { parseTime, parseDecimal } = require('./util');

const SEC_PATH_RE = /^https?:\/\/(?:www\.)?sec\.gov\/Archives\/edgar\/data\/(\d{1,10})\/(\d{18})(?:\/|$)/i;
const FORM_RE = /^[A-Z0-9][A-Z0-9 \-/.]{0,19}$/;

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

    if (item.kind === 'observation' || (f.metric != null && f.value != null)) {
        if (!keys.cik && !keys.symbol) return { type: 'skip', reason: 'no_instrument_key' };
        if (f.metric == null || f.unit == null || !parseDecimal(f.value)) return { type: 'skip', reason: 'incomplete_observation' };
        if (parseTime(f.observed_at) == null) return { type: 'skip', reason: 'no_observation_time' };
        return {
            type: 'observation', keys,
            observation: {
                metric: f.metric, value: f.value, unit: f.unit, currency: f.currency == null ? null : f.currency,
                period: f.period == null ? null : String(f.period), observed_at: f.observed_at, retrieved_at: prov.retrieved_at,
                source_key: item.source_key, source_item_id: item.id, source_url: item.canonical_url || null,
                source_ref: `${item.id}#r${item.revision}:${f.metric}`, max_age_sec: f.max_age_sec == null ? null : f.max_age_sec,
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

module.exports = { mapItem, formType, filerName, accessionOf };
