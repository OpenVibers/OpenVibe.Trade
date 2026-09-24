'use strict';

/**
 * Who is calling, resolved once per request into `req.viewer`:
 *
 *   { kind: 'anonymous', subject: null, editor: false }
 *   { kind: 'user', subject: 'usr_…'|null, editor, user, token }
 *       A browser with the Network user JWT (ov_token cookie or Bearer). The subject comes from the
 *       token's subject_id claim. Editors: staff with staff.editorial.manage (the contracts staff map), or a subject in TRADE_EDITORS.
 *       X-OV-* headers are ignored for browsers.
 *   { kind: 'service', service: 'svc:ai', claims, subject: 'usr_…'|null, origin: 'user'|'ai' }
 *       A first-party service with a Network client-credentials token for audience openvibe.trade.
 *       X-OV-Subject names the person it acts for (watchlists and alert rules need one);
 *       X-OV-Origin: ai marks AI output (OpenVibe.AI's trade.summarize_market_context), which is
 *       never attributed to a person and stays a draft until a person reviews it.
 *       Developer-app (app:…) and module (mod:…) tokens act only for the person in their
 *       on_behalf_of claim: X-OV-Subject naming anyone else is 403, and sandbox tokens are 401.
 *
 * Identity never comes from a request body or query. A request presenting a service token is judged
 * on that token alone: a bad one is refused (problem+json), never downgraded to anonymous.
 */
const contracts = require('openvibe-contracts');
const { extractToken, claimsToUser, decodeJwtPayload } = require('./sso');
const { checkCapability } = require('./capabilities');

const { ids, serviceAuth, http, staff: staffMap } = contracts;
const PRINCIPAL_SUB = /^(svc|app|mod):/;
const AUDIENCE = 'openvibe.trade';

class ViewerError extends Error {
    constructor(status, code, detail) { super(detail); this.status = status; this.code = code; }
}

const ANONYMOUS = Object.freeze({ kind: 'anonymous', subject: null, editor: false, origin: 'user' });

function createViewerResolver({ auth, config }) {
    const editors = new Set(config.editors || []);

    async function fromServiceToken(req, token) {
        const publicKey = await auth.ensureKey();
        if (!publicKey) throw new ViewerError(503, 'identity.unavailable', 'the Network signing key is not loaded yet');
        const r = serviceAuth.verifyServiceToken(token, { publicKey, issuer: config.networkUrl, audience: AUDIENCE });
        if (!r.ok) throw new ViewerError(401, r.code, r.reason);
        // Developer apps (app:…) and modules (mod:…) are third parties: they act only for the person
        // who authorized them (on_behalf_of), never for whoever X-OV-Subject names. Only first-party
        // service principals (svc:…) are trusted to name the acting person.
        const claims = r.claims;
        const firstParty = claims.actor_type === 'service' && String(claims.sub).startsWith('svc:');
        if (!firstParty && claims.env !== undefined && claims.env !== 'production') {
            throw new ViewerError(401, 'token.sandbox_refused', 'sandbox tokens are not accepted by openvibe.trade');
        }
        const originHeader = req.get('x-ov-origin');
        if (originHeader && originHeader !== 'ai' && originHeader !== 'user') throw new ViewerError(400, 'request.invalid_origin', 'X-OV-Origin must be "ai" or "user"');
        const subjectHeader = req.get('x-ov-subject');
        let subject = null;
        if (subjectHeader) {
            if (!ids.isSubjectId('user', subjectHeader)) throw new ViewerError(400, 'subject.invalid', 'X-OV-Subject must be a usr_… subject id');
            if (!firstParty && subjectHeader !== claims.on_behalf_of) {
                throw new ViewerError(403, 'subject.not_delegated', 'an app acts only for the person who authorized it (on_behalf_of)');
            }
            subject = subjectHeader;
        } else if (!firstParty && ids.isSubjectId('user', claims.on_behalf_of)) {
            subject = claims.on_behalf_of;
        }
        return { kind: 'service', service: claims.sub, claims, subject, origin: originHeader === 'ai' ? 'ai' : 'user', editor: false };
    }

    async function fromUserToken(token) {
        const claims = await auth.verify(token);
        if (!claims || (typeof claims.sub === 'string' && PRINCIPAL_SUB.test(claims.sub))) return null;
        const subject = ids.isSubjectId('user', claims.subject_id) ? claims.subject_id : null;
        const editor = staffMap.can(claims, 'staff.editorial.manage') || Boolean(subject && editors.has(subject));
        return { kind: 'user', subject, editor, origin: 'user', user: claimsToUser(claims), token };
    }

    /** opts.services=false (pages) treats a service token as no identity: pages are for browsers. */
    async function resolve(req, opts = {}) {
        const header = String(req.headers.authorization || '');
        if (header.startsWith('Bearer ')) {
            const token = header.slice(7).trim();
            const payload = decodeJwtPayload(token);
            if (payload && typeof payload.sub === 'string' && PRINCIPAL_SUB.test(payload.sub)) {
                if (opts.services === false) return ANONYMOUS;
                return fromServiceToken(req, token);
            }
        }
        const token = extractToken(req);
        if (!token) return ANONYMOUS;
        return (await fromUserToken(token)) || ANONYMOUS;
    }

    function middleware(opts = {}) {
        return async function resolveViewer(req, res, next) {
            try {
                req.viewer = await resolve(req, opts);
                next();
            } catch (err) {
                if (!(err instanceof ViewerError)) return next(err);
                http.sendProblem(res, err.status, err.code, { detail: err.message, ctx: req.ov });
            }
        };
    }

    return { resolve, middleware };
}

/**
 * Route guard: a service token must hold `cap`; browsers and anonymous callers pass here and are
 * judged by ownership or the editor list in the domain layer.
 */
function guard(cap) {
    return function capabilityGuard(req, res, next) {
        const v = req.viewer;
        if (!v || v.kind !== 'service') return next();
        const c = checkCapability(v.claims, cap);
        if (c.allowed) return next();
        return http.sendProblem(res, 403, c.code, { detail: c.reason, ctx: req.ov });
    };
}

module.exports = { createViewerResolver, guard, ANONYMOUS, ViewerError };
