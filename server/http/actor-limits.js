'use strict';
/**
 * Per-actor rate limits on /api/v1 and the watchlist, alert and editor forms (roadmap WS-R task 4;
 * openvibe-sdk/limits).
 *
 * The per-address limits in app.js (/auth, /api/v1, /watchlists, /alerts, /editor) stay. These count
 * requests by who makes them, once req.viewer is resolved (auth/viewer.js) and a route's capability
 * guard (or, for a form, the session and form token) passed:
 *
 *   a person                         user:usr_… (their own token or cookie, a first-party service naming
 *                                    them in X-OV-Subject, or an app's on_behalf_of)
 *   a service or app acting as       its principal (svc:ai, a feed's svc:…, app:app_…)
 *     itself
 *   anyone else                      ip:<address>
 *
 * Reads: a signed-in person's or an app's GET/HEAD under /api/v1 takes TRADE_LIMITS_MINUTE /
 * TRADE_LIMITS_HOUR (120 and 3000). Signed-out reads keep only the per-address limit (many readers
 * share a carrier or campus address), and a first-party service reading for itself is not counted on
 * reads (the per-address /api/v1 limit bounds it). Every write has its own budget below, shared by the
 * API route and the form that do the same thing. Past a limit the route answers 429 problem+json
 * `rate_limited` with Retry-After before any work; the refusal is logged once and counted in
 * trade_rate_limited_total{limit,window}. Counters live in this process: a restart forgets them.
 *
 * Never limited: /api/health, /api/ready, /release.json, /release-metrics, /metrics, sign-in, the pages
 * and feeds people read, and the signed Events deliveries at /internal/events.
 */
const { createActorLimiter, createValkeyLimitStore, defaultActor } = require('openvibe-sdk/limits');

const FIRST_PARTY = /^svc:/;

function actor(req) {
    const v = req.viewer;
    if (!v || v.kind === 'anonymous') return defaultActor(req);
    if (v.subject) return `user:${v.subject}`;
    if (v.kind === 'service' && v.service) return v.service;
    if (v.kind === 'user' && v.user && v.user.id != null) return `user:${v.user.id}`;
    return defaultActor(req);
}

/** Counted on reads: a signed-in person, or a service or app acting for a person or as a third party. */
function countedRead(req) {
    const v = req.viewer;
    if (!v || v.kind === 'anonymous') return false;
    if (v.kind === 'service' && !v.subject && FIRST_PARTY.test(String(v.service))) return false;
    return true;
}

/**
 * The writes, each with its numbers per caller (a minute, an hour). A form and the API route that do
 * the same thing share one budget.
 */
const BUDGETS = {
    // Adding or editing an instrument and its aliases re-indexes it for Search: an editor saves a form
    // every few seconds at most.
    'trade.instrument.manage': { minute: 30, hour: 300 },
    // A first-party feed records one observation per instrument and metric; each is immutable, may fire
    // alerts and emits an event. Up to the per-address /api/v1 limit a minute (240), 10 000 an hour.
    'trade.observation.write': { minute: 240, hour: 10000 },
    // An AI workflow proposes one context revision per instrument it worked on (one a second at most);
    // an editor writes far fewer.
    'trade.context.propose': { minute: 60, hour: 1200 },
    // Reviewing, publishing and retracting context changes what readers, feeds, sitemaps and Search see
    // and emits an event each.
    'trade.context.publish': { minute: 30, hour: 300 },
    // A person keeps a few watchlists.
    'trade.watchlist.create': { minute: 10, hour: 100 },
    // Renaming, deleting and adding or removing instruments: a few clicks in a row.
    'trade.watchlist.update': { minute: 60, hour: 600 },
    // Every alert rule is evaluated against each new observation and document of its instrument.
    'trade.alert.create': { minute: 20, hour: 100 },
    'trade.alert.delete': { minute: 60, hour: 600 },
};

/**
 * limits(name, own) middleware for one app, plus limits.reads(name) (the defaults on a counted
 * GET/HEAD) and limits.budget(name) (one of BUDGETS).
 */
function createActorLimits({ config, now = () => Date.now(), registry = null, log = console, valkey = null }) {
    const refused = registry
        ? registry.counter({ name: 'trade_rate_limited_total', help: 'Requests refused 429 by a per-actor limit, by limit name and window', labelNames: ['limit', 'window'] })
        : null;
    const limiter = createActorLimiter({
        limits: { minute: config.actorLimits.minute, hour: config.actorLimits.hour },
        actor,
        now,
        // Shared across processes on Valkey (ADR-035) when VALKEY_URL is set; in-process otherwise.
        ...(valkey ? { store: createValkeyLimitStore(valkey) } : {}),
        onLimited(e) {
            // The actor is a subject id, a principal or an address, never a token.
            log.warn(`[Trade] limit ${e.name}: ${e.actor} refused, over ${e.limit} per ${e.window}`);
            if (refused) refused.inc({ limit: e.name, window: e.window });
        },
    });
    limiter.reads = (name) => {
        const limit = limiter(name);
        return function actorReadLimit(req, res, next) {
            return (req.method === 'GET' || req.method === 'HEAD') && countedRead(req) ? limit(req, res, next) : next();
        };
    };
    const budgets = new Map(Object.entries(BUDGETS).map(([name, own]) => [name, limiter(name, own)]));
    limiter.budget = (name) => {
        const m = budgets.get(name);
        if (!m) throw new Error(`limits: no budget named ${name}`);
        return m;
    };
    return limiter;
}

module.exports = { createActorLimits, actor, countedRead, BUDGETS };
