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
    // Per-actor limits (http/actor-limits.js): each form names its budget, shared with the API route that
    // does the same thing, checked once the session and form token are.
    const B = (name) => ctx.limits.budget(name);
    const privateDecision = seo.evaluate({ state: 'published', visibility: 'private', canonicalUrl: null }, { policy: { minWords: 0 } });

    function back(req, res, fallback, err) {
        const e = asApiError(err);
        if (!e) throw err;
        common.after(res, fallback, { e: e.message });
    }

    async function instrumentFrom(body) {
        if (body.symbol) return await instruments.bySymbol(body.symbol);
        const r = await instruments.resolve(body.q);
        return r.status === 'resolved' ? r.instrument : null;
    }

    define(router, 'get', '/watchlists', 'showWatchlists', async (req, res) => {
        const v = req.viewer;
        const signedIn = v.kind === 'user' && v.subject;
        const lists = signedIn ? (await Promise.all((await watchlists.forOwner(v.subject)).map(async (w) => await watchlists.dto(w)))) : [];
        common.page(req, res, {
            title: 'Your watchlists', decision: privateDecision, personal: true,
            body: views.watchlistsPage({
                viewer: v, lists, rules: signedIn ? await alerts.forOwner(v.subject) : [], deliveries: signedIn ? await alerts.deliveries(v.subject, 20) : [],
                csrf: common.csrf(req), loginHref: common.loginHref(req), notice: common.noticeOf(req),
            }),
        });
    });

    define(router, 'post', '/watchlists', 'createWatchlistForm', ...common.signedInForm, B('trade.watchlist.create'), async (req, res) => {
        try {
            await watchlists.create(req.viewer.subject, { name: req.body.name });
            common.after(res, '/watchlists', { n: 'watchlist_created' });
        } catch (err) { back(req, res, '/watchlists', err); }
    });

    define(router, 'post', '/watchlists/rename', 'renameWatchlistForm', ...common.signedInForm, B('trade.watchlist.update'), async (req, res) => {
        try {
            await watchlists.rename(await watchlists.mustOwn(req.viewer.subject, req.body.watchlist_id), { name: req.body.name });
            common.after(res, '/watchlists', { n: 'watchlist_renamed' });
        } catch (err) { back(req, res, '/watchlists', err); }
    });

    define(router, 'post', '/watchlists/delete', 'deleteWatchlistForm', ...common.signedInForm, B('trade.watchlist.update'), async (req, res) => {
        try {
            await watchlists.remove(await watchlists.mustOwn(req.viewer.subject, req.body.watchlist_id));
            common.after(res, '/watchlists', { n: 'watchlist_deleted' });
        } catch (err) { back(req, res, '/watchlists', err); }
    });

    define(router, 'post', '/watchlists/item', 'addWatchlistItemForm', ...common.signedInForm, B('trade.watchlist.update'), async (req, res) => {
        try {
            const w = await watchlists.mustOwn(req.viewer.subject, req.body.watchlist_id);
            const instrument = await instrumentFrom(req.body);
            const added = await watchlists.add(w, instrument, req.body.note);
            const from = req.get('referer') && /\/i\//.test(new URL(req.get('referer'), ctx.config.baseUrl).pathname) ? `/i/${encodeURIComponent(instrument.symbol)}` : '/watchlists';
            common.after(res, from, { n: added ? 'item_added' : 'item_present' });
        } catch (err) { back(req, res, '/watchlists', err); }
    });

    define(router, 'post', '/watchlists/item/remove', 'removeWatchlistItemForm', ...common.signedInForm, B('trade.watchlist.update'), async (req, res) => {
        try {
            const w = await watchlists.mustOwn(req.viewer.subject, req.body.watchlist_id);
            await watchlists.drop(w, await instruments.bySymbol(req.body.symbol));
            common.after(res, '/watchlists', { n: 'item_removed' });
        } catch (err) { back(req, res, '/watchlists', err); }
    });

    define(router, 'post', '/alerts', 'createAlertForm', ...common.signedInForm, B('trade.alert.create'), async (req, res) => {
        const instrument = await instruments.bySymbol(req.body.symbol);
        try {
            await alerts.create(req.viewer.subject, instrument, {
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

    define(router, 'post', '/alerts/delete', 'deleteAlertForm', ...common.signedInForm, B('trade.alert.delete'), async (req, res) => {
        try {
            await alerts.remove(req.viewer.subject, String(req.body.rule_id || ''));
            common.after(res, '/watchlists', { n: 'alert_deleted' });
        } catch (err) { back(req, res, '/watchlists', err); }
    });

    return router;
}

module.exports = { createPrivate };
