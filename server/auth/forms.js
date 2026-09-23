'use strict';

/**
 * Form tokens for the no-JavaScript editor and comment forms (CSRF). The session cookie is
 * SameSite=Lax already; the token is the second lock: an HMAC of the signed-in subject under
 * TRADE_FORM_SECRET (a random per-process key when unset, so forms opened before a restart must be
 * reloaded). Never derived from anything a cross-site page can read.
 */
const crypto = require('crypto');

const fallback = crypto.randomBytes(32).toString('hex');

function csrfToken(config, viewer) {
    if (!viewer || !viewer.subject) return '';
    return crypto.createHmac('sha256', config.formSecret || fallback).update(`trade-form:${viewer.subject}`).digest('base64url').slice(0, 32);
}

function checkCsrf(config, viewer, token) {
    const expected = csrfToken(config, viewer);
    if (!expected || typeof token !== 'string' || token.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

module.exports = { csrfToken, checkCsrf };
