'use strict';

/**
 * Private pages and forms: watchlists and alert rules. Only for the signed-in owner; every response
 * is Cache-Control: private, no-store with X-Robots-Tag: noindex, nofollow. Someone else's
 * watchlist or rule answers "not found". Plain HTML forms with the form token (no JavaScript).
 *
 *   GET  /watchlists                       your watchlists, alert rules and recent deliveries
 *   POST /watchlists                       create { name }
 *   POST /watchlists/rename                { watchlist_id, name }
 *   POST /watchlists/delete                { watchlist_id }
 *   POST /watchlists/item                  add { watchlist_id, symbol | q, note? }
 *   POST /watchlists/item/remove           { watchlist_id, symbol }
 *   POST /alerts                           create { symbol, kind, … }
 *   POST /alerts/delete                    { rule_id }
 */
const express = require('express');
const seo = require('openvibe-publishing/seo');
const views = require('../render/views');
const { define } = require('./routes');
const { asApiError } = require('./errors');

function createPrivate(ctx) {
    const { instruments, watchlists, alerts, common } = ctx;
    const router = express.Router();
    const privateDecision = seo.evaluate({ state: 'published', visibility: 'private', canonicalUrl: null }, { policy: { minWords: 0 } });

    function back(req, res, fallback, err) {
        const e = asApiError(err);
        if (!e) throw err;
        common.after(res, fallback, { e: e.message });
    }

    function instrumentFrom(body) {
        if (body.symbol) return instruments.bySymbol(body.symbol);
        const r = instruments.resolve(body.q);
        return r.status === 'resolved' ? r.instrument : null;
    }

    define(router, 'get', '/watchlists', 'showWatchlists', (req, res) => {
        const v = req.viewer;
        const signedIn = v.kind === 'user' && v.subject;
        const lists = signedIn ? watchlists.forOwner(v.subject).map((w) => watchlists.dto(w)) : [];
        common.page(req, res, {
            title: 'Your watchlists', decision: privateDecision, personal: true,
            body: views.watchlistsPage({
                viewer: v, lists, rules: signedIn ? alerts.forOwner(v.subject) : [], deliveries: signedIn ? alerts.deliveries(v.subject, 20) : [],
                csrf: common.csrf(req), loginHref: common.loginHref(req), notice: common.noticeOf(req),
            }),
        });
    });

    define(router, 'post', '/watchlists', 'createWatchlistForm', ...common.signedInForm, (req, res) => {
        try {
            watchlists.create(req.viewer.subject, { name: req.body.name });
            common.after(res, '/watchlists', { n: 'watchlist_created' });
        } catch (err) { back(req, res, '/watchlists', err); }
    });

    define(router, 'post', '/watchlists/rename', 'renameWatchlistForm', ...common.signedInForm, (req, res) => {
        try {
            watchlists.rename(watchlists.mustOwn(req.viewer.subject, req.body.watchlist_id), { name: req.body.name });
            common.after(res, '/watchlists', { n: 'watchlist_renamed' });
        } catch (err) { back(req, res, '/watchlists', err); }
    });

    define(router, 'post', '/watchlists/delete', 'deleteWatchlistForm', ...common.signedInForm, (req, res) => {
        try {
            watchlists.remove(watchlists.mustOwn(req.viewer.subject, req.body.watchlist_id));
            common.after(res, '/watchlists', { n: 'watchlist_deleted' });
        } catch (err) { back(req, res, '/watchlists', err); }
    });

    define(router, 'post', '/watchlists/item', 'addWatchlistItemForm', ...common.signedInForm, (req, res) => {
        try {
            const w = watchlists.mustOwn(req.viewer.subject, req.body.watchlist_id);
            const instrument = instrumentFrom(req.body);
            const added = watchlists.add(w, instrument, req.body.note);
            const from = req.get('referer') && /\/i\//.test(new URL(req.get('referer'), ctx.config.baseUrl).pathname) ? `/i/${encodeURIComponent(instrument.symbol)}` : '/watchlists';
            common.after(res, from, { n: added ? 'item_added' : 'item_present' });
        } catch (err) { back(req, res, '/watchlists', err); }
    });

    define(router, 'post', '/watchlists/item/remove', 'removeWatchlistItemForm', ...common.signedInForm, (req, res) => {
        try {
            const w = watchlists.mustOwn(req.viewer.subject, req.body.watchlist_id);
            watchlists.drop(w, instruments.bySymbol(req.body.symbol));
            common.after(res, '/watchlists', { n: 'item_removed' });
        } catch (err) { back(req, res, '/watchlists', err); }
    });

    define(router, 'post', '/alerts', 'createAlertForm', ...common.signedInForm, (req, res) => {
        const instrument = instruments.bySymbol(req.body.symbol);
        try {
            alerts.create(req.viewer.subject, instrument, {
                kind: req.body.kind, metric: req.body.metric, operator: req.body.operator, threshold: req.body.threshold,
                unit: req.body.unit, currency: req.body.currency, form_types: req.body.form_types,
            });
            common.after(res, instrument ? `/i/${encodeURIComponent(instrument.symbol)}` : '/watchlists', { n: 'alert_created' });
        } catch (err) {
            const e = asApiError(err);
            if (!e) throw err;
            common.after(res, instrument ? `/i/${encodeURIComponent(instrument.symbol)}` : '/watchlists', { e: e.message });
        }
    });

    define(router, 'post', '/alerts/delete', 'deleteAlertForm', ...common.signedInForm, (req, res) => {
        try {
            alerts.remove(req.viewer.subject, String(req.body.rule_id || ''));
            common.after(res, '/watchlists', { n: 'alert_deleted' });
        } catch (err) { back(req, res, '/watchlists', err); }
    });

    return router;
}

module.exports = { createPrivate };
