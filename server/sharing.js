'use strict';

/**
 * Sharing on OpenVibe.Trade (design 2026-11-06, visibility step 6), through openvibe-sdk/share.
 *
 * A watchlist is Only me until its owner says otherwise. The Share sheet changes just that list; the person's default
 * for new lists lives on /watchlists ("New watchlists: Only me"). A shared list's page and its API read ask the one
 * check, canView; adding or removing instruments asks canEdit, so a list shared with Specific people Can edit is one a
 * friend can actually build with you.
 *
 * The SDK owns the model and the rules (the shares row, members, requests, transfers, the log and the delivery
 * queue). This file is the wiring: Network's name lookups and notifications, Events for share.* envelopes, and the
 * person's default. A watchlist has no visibility column to keep in step: its share row is the authority.
 */
const { createShares } = require('openvibe-sdk/share');
const { serviceAuth } = require('openvibe-contracts');

const SERVICE = 'trade';
const KIND = 'watchlist';
const AUDIENCES = ['public', 'link', 'people', 'private'];
const DEFAULT_AUDIENCE = 'private';
/** A watchlist is never listed: no Everyone. The sheet offers these three. */
const OFFERED = ['private', 'link', 'people'];

const refOf = (id) => ({ service: SERVICE, kind: KIND, id: String(id) });

/** Trade's viewer as the SDK wants it: a subject object. An editor is not staff for a person's watchlist. */
function shareViewer(v) {
    if (!v || v.kind !== 'user' || !v.subject) return null;
    return { subject: { type: 'user', id: String(v.subject) }, staff: false };
}

function createSharing({ db, config, fetchImpl = globalThis.fetch, log = console } = {}) {
    const base = String(config.networkInternalUrl || '').replace(/\/+$/, '');
    const tokens = config.oauth && config.oauth.clientSecret ? serviceAuth.createTokenClient({
        tokenUrl: base + '/oauth/token',
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.network',
        scope: 'identity.subject.resolve network.notifications.push',
        fetch: fetchImpl,
    }) : null;

    async function networkJson({ path, method = 'GET', json, query } = {}) {
        if (!tokens) throw new Error('Network is not configured for this service');
        const url = new URL(base + path);
        for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, String(v));
        const headers = { Accept: 'application/json', ...(await tokens.authHeaders()) };
        if (json !== undefined) headers['Content-Type'] = 'application/json';
        const res = await fetchImpl(url, { method, headers, body: json === undefined ? undefined : JSON.stringify(json), signal: AbortSignal.timeout(8000) });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
            const err = new Error('Network ' + method + ' ' + path + ' ' + res.status + ': ' + ((body && (body.detail || body.error)) || 'failed'));
            err.status = res.status;
            throw err;
        }
        return body;
    }

    /** One notification. It never carries the watchlist's name or the instruments on it. */
    async function notify(n) {
        const to = n && n.to;
        if (!to || to.type !== 'user') return;
        const words = {
            'share.added': ['A watchlist was shared with you', 'Open it on OpenVibe.Trade.'],
            'share.access_requested': ['Someone asked for access to your watchlist', 'Review the request on OpenVibe.Trade.'],
            'share.transfer.requested': ['Someone wants to give you a watchlist', 'Accept or decline it on OpenVibe.Trade.'],
            'share.transfer.answered': ['A watchlist transfer was answered', 'See what happened on OpenVibe.Trade.'],
        }[n.kind] || ['Sharing on OpenVibe.Trade', 'There is something new for you.'];
        try {
            await networkJson({
                path: '/internal/notifications/push', method: 'POST',
                json: {
                    subject: to.id, type: 'GENERIC', title: words[0], message: words[1],
                    service: 'trade', url: n.ref && n.ref.id ? `${config.baseUrl}/watchlists/${encodeURIComponent(n.ref.id)}` : `${config.baseUrl}/watchlists`,
                    category: 'social',
                },
            });
        } catch (err) {
            // Network may not have seeded Trade's network.notifications.push grant yet: the share still happened
            // (it is decided by canView), the person just hears about it elsewhere.
            log.warn('[Sharing] notification not sent:', err.message);
        }
    }

    /** OpenVibe.Events: one share.* envelope. A refusal only loses the event copy, never the setting. */
    async function publish(envelope) {
        if (!config.events || !config.events.url) { log.warn('[Sharing] no events URL configured; share envelope not sent'); return; }
        const res = await fetchImpl(String(config.events.url).replace(/\/+$/, ''), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(envelope),
            signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error('Events answered ' + res.status);
    }

    const shares = createShares({
        db,
        network: { json: networkJson },
        events: { publish },
        notify,
    });

    return {
        shares,
        SERVICE,
        KIND,
        AUDIENCES,
        OFFERED,
        DEFAULT_AUDIENCE,
        refOf,
        shareViewer,
        networkJson,
        /** Register a watchlist, at the owner's default until the Share sheet says otherwise. */
        register: async (subject, id, audience = DEFAULT_AUDIENCE) => await shares.register(refOf(id), {
            owner_subject: { type: 'user', id: String(subject) },
            audience: AUDIENCES.includes(audience) ? audience : DEFAULT_AUDIENCE,
        }),
        canView: async (viewer, id) => await shares.canView(shareViewer(viewer), refOf(id)),
        canEdit: async (viewer, id) => await shares.canEdit(shareViewer(viewer), refOf(id)),
        setAudience: async (viewer, id, audience) => await shares.setAudience(shareViewer(viewer), refOf(id), audience),
        /** The share row, or null for a list that predates the backfill (its owner alone decides then). */
        shareOf: async (id) => await db.maybe('SELECT * FROM shares WHERE service = $1 AND kind = $2 AND resource_id = $3',
            [SERVICE, KIND, String(id)]),
        /** Just the audience, for deciding between "Only me" (no hint) and "Specific people" (the gate). */
        audienceOf: async (id) => {
            const row = await db.maybe('SELECT audience FROM shares WHERE service = $1 AND kind = $2 AND resource_id = $3',
                [SERVICE, KIND, String(id)]);
            return row ? row.audience : null;
        },
        defaultOf: async (subject) => {
            if (!subject) return DEFAULT_AUDIENCE;
            const row = await db.maybe('SELECT audience FROM trade_share_defaults WHERE subject = $1', [String(subject)]);
            return row && AUDIENCES.includes(row.audience) ? row.audience : DEFAULT_AUDIENCE;
        },
        /** Set the default, and with `applyAll` move the person's existing lists too (design rule 2). */
        setDefault: async (subject, audience, { applyAll = false } = {}) => {
            if (!subject) return false;
            const want = AUDIENCES.includes(audience) ? audience : DEFAULT_AUDIENCE;
            await db.exec(`INSERT INTO trade_share_defaults (subject, audience, updated_at) VALUES ($1, $2, now())
                ON CONFLICT (subject) DO UPDATE SET audience = excluded.audience, updated_at = now()`, [String(subject), want]);
            if (applyAll) {
                await db.exec(`UPDATE shares SET audience = $1, revision = revision + 1
                    WHERE service = $2 AND kind = $3 AND owner_subject->>'id' = $4 AND owner_subject->>'type' = 'user'`,
                    [want, SERVICE, KIND, String(subject)]);
            }
            return true;
        },
        /** The uniform API's describe(ref): the list's name, its page, and only the audiences a list may use. */
        describe: async (ref) => {
            if (ref.service !== SERVICE || ref.kind !== KIND) return {};
            const row = await db.maybe('SELECT id, name FROM trade_watchlists WHERE id = $1', [String(ref.id)]);
            if (!row) return {};
            return {
                title: String(row.name || 'A watchlist').slice(0, 120),
                link: `${config.baseUrl}/watchlists/${encodeURIComponent(row.id)}`,
                roles: ['viewer', 'editor'],
                audiences: OFFERED,
                transferable: false,
            };
        },
        /** A deleted watchlist takes its share row and everyone it named with it. */
        forget: async (id) => {
            for (const table of ['share_members', 'share_transfers', 'share_access_requests']) {
                await db.exec(`DELETE FROM ${table} WHERE service = $1 AND kind = $2 AND resource_id = $3`, [SERVICE, KIND, String(id)]);
            }
            await db.exec('DELETE FROM shares WHERE service = $1 AND kind = $2 AND resource_id = $3', [SERVICE, KIND, String(id)]);
        },
        /** Expire members and transfers, then send the queued events and notifications. */
        work: async ({ flush = true } = {}) => {
            let expired = 0;
            try { expired = await shares.expireMembers(); } catch (err) { log.warn('[Sharing] expiry sweep:', err.message); }
            let sent = 0;
            if (flush) { try { sent = await shares.flush(); } catch (err) { log.warn('[Sharing] deliveries:', err.message); } }
            return { expired, sent };
        },
    };
}

module.exports = { createSharing, shareViewer, refOf, AUDIENCES, OFFERED, DEFAULT_AUDIENCE, SERVICE, KIND };
