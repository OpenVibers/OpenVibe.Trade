'use strict';

/**
 * Shared helpers for the HTML routers: caching, the page renderer, form parsing with the CSRF
 * check, notices after a redirect, and the not-found page.
 *
 * Caching (no leaks through shared caches):
 *   - public, max-age=60   only pages that are the same for everyone, served to an anonymous viewer
 *   - private, no-store    everything personal (signed-in views, watchlists, alerts, the editor),
 *                          every error and every form response
 *   Every HTML response varies on Cookie and Authorization.
 */
const express = require('express');
const seo = require('openvibe-publishing/seo');
const { renderPage } = require('../render/layout');
const views = require('../render/views');
const { csrfToken, checkCsrf } = require('../auth/forms');
const { ApiError, asApiError, privateNoStore } = require('./errors');

const NOTICES = {
    watchlist_created: 'Watchlist created.',
    watchlist_renamed: 'Watchlist renamed.',
    watchlist_deleted: 'Watchlist deleted.',
    item_added: 'Added to your watchlist.',
    item_present: 'It was already on that watchlist.',
    item_removed: 'Removed from your watchlist.',
    alert_created: 'Alert created. You will be notified once per triggering document or observation.',
    alert_deleted: 'Alert deleted.',
    instrument_created: 'Instrument added.',
    instrument_saved: 'Saved.',
    alias_added: 'Alias added.',
    context_saved: 'Context revision saved.',
    context_published: 'Context published.',
    context_rejected: 'Review recorded: rejected.',
    context_retracted: 'Published context retracted.',
};

function createCommon({ config, store }) {
    const formBody = express.urlencoded({ extended: false, limit: '64kb' });

    function vary(res) { res.vary('Cookie'); res.vary('Authorization'); }

    function cacheFor(req, res, { personal = false } = {}) {
        vary(res);
        if (personal || (req.viewer && req.viewer.kind !== 'anonymous')) privateNoStore(res);
        else res.set('Cache-Control', 'public, max-age=60');
    }

    /** Render a full page. o: status, title, description, decision, canonical, body, jsonLd, feeds, personal */
    function page(req, res, o) {
        const decision = o.decision || seo.evaluate({ state: 'published', visibility: 'public', canonicalUrl: o.canonical || null, noindex: true }, { policy: { minWords: 0 } });
        cacheFor(req, res, { personal: o.personal || (o.status && o.status >= 400) });
        res.set('X-Robots-Tag', decision.robots);
        res.status(o.status || 200).type('html').send(renderPage({ ...o, decision, viewer: req.viewer, config, path: req.originalUrl }));
    }

    function notFound(req, res, message = 'There is nothing at this address.') {
        page(req, res, { status: 404, title: 'Not found', body: views.errorPage({ status: 404, title: 'Not found', message }), personal: true });
    }

    function failure(req, res, err) {
        const e = asApiError(err);
        if (!e) throw err;
        page(req, res, { status: e.status, title: e.status === 404 ? 'Not found' : 'That did not work', body: views.errorPage({ status: e.status, title: e.status === 404 ? 'Not found' : 'That did not work', message: e.message }), personal: true });
    }

    const noticeOf = (req) => {
        const n = req.query && typeof req.query.n === 'string' ? req.query.n : null;
        if (n && NOTICES[n]) return { text: NOTICES[n] };
        const e = req.query && typeof req.query.e === 'string' ? req.query.e.slice(0, 300) : null;
        return e ? { text: e, error: true } : null;
    };

    /** Form middleware: parse, require a signed-in person, check the form token. */
    const signedInForm = [formBody, function requireFormSession(req, res, next) {
        if (!req.viewer || req.viewer.kind !== 'user' || !req.viewer.subject) {
            privateNoStore(res);
            return res.redirect(303, `/auth/login?next=${encodeURIComponent(req.get('referer') ? new URL(req.get('referer'), config.baseUrl).pathname : '/watchlists')}`);
        }
        if (!checkCsrf(config, req.viewer, req.body && req.body._csrf)) {
            return failure(req, res, new ApiError(403, 'form.token_invalid', 'This form expired. Go back, reload the page and try again.'));
        }
        next();
    }];

    const loginHref = (req) => `/auth/login?next=${encodeURIComponent(req.originalUrl || '/')}`;

    /** Redirect after a form, with a notice code or an error message. */
    function after(res, path, { n, e } = {}) {
        privateNoStore(res);
        const url = new URL(path, config.baseUrl);
        if (n) url.searchParams.set('n', n);
        if (e) url.searchParams.set('e', e);
        res.redirect(303, url.pathname + url.search + url.hash);
    }

    return {
        page, notFound, failure, cacheFor, vary, noticeOf, signedInForm, formBody, loginHref, after,
        csrf: (req) => csrfToken(config, req.viewer),
        now: () => store.now(),
    };
}

module.exports = { createCommon, NOTICES };
