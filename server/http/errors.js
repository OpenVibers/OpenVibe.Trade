'use strict';

/**
 * Errors as RFC 9457 problems (contracts errors.problem@1, which keeps the legacy { error } field),
 * and the small request helpers every router shares.
 */
const express = require('express');
const contracts = require('openvibe-contracts');

/** A refusal with a stable problem code (e.g. 404 'post.not_found'). */
class ApiError extends Error {
    constructor(status, code, detail, extra) {
        super(detail || code);
        this.name = 'ApiError';
        this.status = status;
        this.code = code;
        this.extra = extra || null;
    }
}

/** Publishing package errors carry { status, code } too. */
function asApiError(err) {
    if (err instanceof ApiError) return err;
    if (err && err.name === 'PublishingError' && Number.isInteger(err.status)) {
        const extra = err.code === 'revision.conflict' ? { expected: err.expected, current: err.current } : null;
        return new ApiError(err.status, err.code, err.message, extra);
    }
    if (err instanceof TypeError && err.message && !/Cannot read|is not a function|undefined/.test(err.message)) {
        return new ApiError(422, 'request.invalid', err.message);
    }
    return null;
}

/** Wrap a JSON handler: its return value is the body; errors become problems. */
function run(fn, status = 200) {
    return async (req, res) => {
        try {
            const out = await fn(req, res);
            if (out === undefined || res.headersSent) return;
            res.status(typeof status === 'function' ? status(out) : status).json(out);
        } catch (err) {
            if (res.headersSent) return;
            const e = asApiError(err);
            if (e) return contracts.http.sendProblem(res, e.status, e.code, { detail: e.message, ctx: req.ov, extra: e.extra || undefined });
            console.error('[Trade API]', err && err.stack ? err.stack : err);
            contracts.http.sendProblem(res, 500, 'internal.error', { detail: 'Internal error', ctx: req.ov });
        }
    };
}

const jsonParser = express.json({ limit: '512kb' });
/** JSON body parser whose syntax errors are problems too. */
function jsonBody(req, res, next) {
    jsonParser(req, res, (err) => (err ? contracts.http.sendProblem(res, 400, 'request.invalid_json', { detail: 'Malformed JSON body', ctx: req.ov }) : next()));
}

/** Private, per-viewer responses: never stored by a shared cache, never indexed. */
function privateNoStore(res) {
    res.set('Cache-Control', 'private, no-store');
    res.vary('Cookie');
    res.vary('Authorization');
}

module.exports = { ApiError, asApiError, run, jsonBody, privateNoStore };
