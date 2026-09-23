'use strict';

/** Small shared helpers: ids, times, decimals, validation errors. Nothing here invents a value. */
const { ids } = require('openvibe-contracts');
const { ApiError } = require('../http/errors');

const newId = (prefix, now) => `${prefix}_${ids.ulid(now)}`;

/** epoch ms → ISO string, or null. */
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

/**
 * A date the caller STATES: an ISO 8601 date-time with a zone (…Z or ±hh:mm), or epoch ms as a
 * number. Anything else (including a missing value) is null — never "now".
 */
function parseTime(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
    const s = String(v).trim();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/i.test(s)) return null;
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
}

const DECIMAL_RE = /^-?(\d{1,20})(\.\d{1,12})?([eE][-+]?\d{1,3})?$/;

/** A decimal as stated: → { text, num } or null. Numbers are kept as their shortest string form. */
function parseDecimal(v) {
    if (typeof v === 'number') {
        if (!Number.isFinite(v)) return null;
        return { text: String(v), num: v };
    }
    if (typeof v !== 'string') return null;
    const s = v.trim();
    if (!DECIMAL_RE.test(s)) return null;
    const num = Number(s);
    return Number.isFinite(num) ? { text: s, num } : null;
}

const invalid = (detail, code = 'request.invalid') => new ApiError(422, code, detail);

function str(v, max, name, { required = false } = {}) {
    if (v == null || v === '') {
        if (required) throw invalid(`${name} is required`);
        return null;
    }
    if (typeof v !== 'string') throw invalid(`${name} must be a string`);
    const s = v.trim();
    if (!s && required) throw invalid(`${name} is required`);
    if (s.length > max) throw invalid(`${name} is longer than ${max} characters`);
    return s || null;
}

function httpUrl(v, name) {
    if (v == null || v === '') return null;
    let u;
    try { u = new URL(String(v)); } catch { throw invalid(`${name} must be an absolute URL`); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw invalid(`${name} must be http(s)`);
    return u.toString();
}

/** Parse JSON stored by this service; a broken value is an empty default, never a crash. */
function json(text, def) {
    if (text == null) return def;
    try { return JSON.parse(text); } catch { return def; }
}

module.exports = { newId, iso, parseTime, parseDecimal, invalid, str, httpUrl, json };
