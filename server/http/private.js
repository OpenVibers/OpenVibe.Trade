'use strict';

/**
 * Private pages and forms: watchlists and alert rules. A watchlist is the signed-in owner's, or a shared one a reader
 * may open; every response is Cache-Control: private, no-store with X-Robots-Tag: noindex, nofollow. Someone else's
 * watchlist or rule answers "not found" (a Specific-people list answers the gate). Plain HTML forms with the form token.
 *
 *   GET  /watchlists                       your watchlists, their default audience, alert rules and recent deliveries
 *   GET  /watchlists/:id                   one watchlist: its owner's, or a shared one (canView)
 *   POST /watchlists                       create { name }
 *   POST /watchlists/defaults              { audience, apply_all? } the person's default for new lists
 *   POST /watchlists/rename                { watchlist_id, name } (owner)
 *   POST /watchlists/delete                { watchlist_id } (owner)
 *   POST /watchlists/item                  add { watchlist_id, symbol | q, note? } (owner or Can edit)
 *   POST /watchlists/watch                 one tap: add to the first watchlist, creating "Watching" when there is none
 *   POST /watchlists/item/remove           { watchlist_id, symbol } (owner or Can edit)
 *   POST /alerts                           create { symbol, kind, … }
 *   POST /alerts/delete                    { rule_id }
 */
const express = require('express');
const seo = require('openvibe-publishing/seo');
const ovServe = require('openvibe-shared/serve');
const views = require('../render/views');
const { define } = require('./routes');
const { asApiError, ApiError } = require('./errors');

// The one Share sheet (openvibe-shared ov-share.js): its stylesheet and script, and the gate that draws itself from
// markup. A page with a Share button needs the shared navbar, which loads the sheet on the first press.
const SHARE_HEAD = `<link rel="stylesheet" href="${ovServe.url('ov-share.css')}"><script src="${ovServe.url('ov-share.js')}" defer></script>`;

function createPrivate(ctx) {
    const { instruments, watchlists, alerts, common, config } = ctx;
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

    /** A watchlist this viewer may change: the owner's, or one shared with them Can edit. */
    async function editable(req) {
        const out = await watchlists.mustView(req.viewer, req.body.watchlist_id);
        if (!out.canEdit) throw new ApiError(403, 'watchlist.read_only', 'This watchlist is shared with you as a view-only list');
        return out.list;
    }

    define(router, 'get', '/watchlists', 'showWatchlists', async (req, res) => {
        const v = req.viewer;
        const signedIn = v.kind === 'user' && v.subject;
        const lists = signedIn ? (await Promise.all((await watchlists.forOwner(v.subject)).map(async (w) => await watchlists.dto(w)))) : [];
        const defaultAudience = signedIn && ctx.sharing ? await ctx.sharing.defaultOf(v.subject).catch(() => 'private') : 'private';
        common.page(req, res, {
            title: 'Your watchlists', decision: privateDecision, personal: true, head: SHARE_HEAD,
            body: views.watchlistsPage({
                viewer: v, lists, defaultAudience, rules: signedIn ? await alerts.forOwner(v.subject) : [], deliveries: signedIn ? await alerts.deliveries(v.subject, 20) : [],
                csrf: common.csrf(req), loginHref: common.loginHref(req), notice: common.noticeOf(req),
            }),
        });
    });

    // The person's default for new watchlists, and "apply to all" (design rule 2). Just the default changes; a list's
    // Share button changes that one.
    define(router, 'post', '/watchlists/defaults', 'setWatchlistDefault', ...common.signedInForm, async (req, res) => {
        if (!ctx.sharing) return res.redirect(303, '/watchlists');
        const audience = ['private', 'people', 'link', 'public'].includes(req.body.audience) ? req.body.audience : 'private';
        await ctx.sharing.setDefault(req.viewer.subject, audience, { applyAll: String(req.body.apply_all || '') === '1' })
            .catch((err) => ctx.log.warn('[Trade] the watchlist default was not saved:', err.message));
        return res.redirect(303, '/watchlists');
    });

    // One watchlist's own page (design 2026-11-06, step 6): its owner's, or a reader it was shared with. A list shared
    // with specific people answers the gate to everyone else and never shows its name or instruments.
    define(router, 'get', '/watchlists/:id', 'showWatchlist', async (req, res) => {
        const id = String(req.params.id || '');
        const out = await watchlists.view(req.viewer, id);
        if (!out) {
            const audience = ctx.sharing ? await ctx.sharing.audienceOf(id).catch(() => null) : null;
            if (audience === 'people') {
                const signedIn = req.viewer.kind === 'user' && req.viewer.subject;
                return common.page(req, res, {
                    status: 404, title: 'A watchlist shared with specific people', head: SHARE_HEAD, personal: true,
                    body: views.watchlistGate({
                        id, signedInAs: signedIn ? (req.viewer.user && req.viewer.user.username) || '' : '',
                        signInUrl: `/auth/login?next=${encodeURIComponent(req.originalUrl)}`,
                    }),
                });
            }
            return common.notFound(req, res);
        }
        const audience = ctx.sharing ? await ctx.sharing.audienceOf(id).catch(() => null) : null;
        common.page(req, res, {
            title: out.list.name, decision: privateDecision, personal: true, head: SHARE_HEAD,
            body: views.watchlistPage({
                list: out.list, items: await watchlists.items(out.list), mine: out.mine, canEdit: out.canEdit,
                audience, csrf: common.csrf(req), loginHref: common.loginHref(req), notice: common.noticeOf(req),
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
            const w = await editable(req);
            const instrument = await instrumentFrom(req.body);
            const added = await watchlists.add(w, instrument, req.body.note);
            const from = req.get('referer') && /\/i\//.test(new URL(req.get('referer'), ctx.config.baseUrl).pathname) ? `/i/${encodeURIComponent(instrument.symbol)}` : '/watchlists';
            common.after(res, from, { n: added ? 'item_added' : 'item_present' });
        } catch (err) { back(req, res, '/watchlists', err); }
    });

    // One tap on an instrument page: keep the instrument on the first watchlist, or on a new one called "Watching".
    // The full form below it still names any other list; this route exists so the first tap needs no choice.
    define(router, 'post', '/watchlists/watch', 'watchInstrumentForm', ...common.signedInForm, B('trade.watchlist.update'), async (req, res) => {
        try {
            const instrument = await instruments.bySymbol(req.body.symbol);
            if (!instrument) throw new ApiError(404, 'instrument.not_found', 'No such instrument');
            const subject = req.viewer.subject;
            const lists = await watchlists.forOwner(subject);
            const list = lists[0] || await watchlists.create(subject, { name: 'Watching' });
            const added = await watchlists.add(list, instrument);
            common.after(res, `/i/${encodeURIComponent(instrument.symbol)}`, { n: added ? 'item_added' : 'item_present' });
        } catch (err) { back(req, res, '/watchlists', err); }
    });

    define(router, 'post', '/watchlists/item/remove', 'removeWatchlistItemForm', ...common.signedInForm, B('trade.watchlist.update'), async (req, res) => {
        try {
            const w = await editable(req);
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
