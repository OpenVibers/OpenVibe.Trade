'use strict';

/**
 * Capability checks for service tokens (audience openvibe.trade), including the ids Trade
 * introduces before the contracts library knows them.
 *
 * openvibe-contracts' capabilities.check() answers capability.unknown for an id that is not in its
 * manifests yet. Trade's ids are proposed in docs/capabilities-proposal/ for the next contracts
 * release; until then a grant is decided locally with the library's own matching rule (the exact
 * id, or a `prefix.*` grant covering it). An id the library does know always goes through the
 * library, so the day the release lands nothing changes here.
 *
 * Browsers (Network user JWTs) are never judged by capabilities: watchlists and alert rules by
 * ownership, editing by the editor list (domain/access.js). A service token is judged by its
 * capability AND, for private data, by the person it acts for (X-OV-Subject).
 *
 * There is deliberately no capability for anything that moves value: ADR-025 (information only).
 */
const { capabilities } = require('openvibe-contracts');

const CAPABILITIES = Object.freeze({
    INSTRUMENT_RESOLVE: 'trade.instrument.resolve',
    INSTRUMENT_MANAGE: 'trade.instrument.manage',
    OBSERVATION_WRITE: 'trade.observation.write',
    CONTEXT_READ: 'trade.context.read',
    CONTEXT_PROPOSE: 'trade.context.propose',
    WATCHLIST_READ: 'trade.watchlist.read',
    WATCHLIST_CREATE: 'trade.watchlist.create',
    WATCHLIST_UPDATE: 'trade.watchlist.update',
    WATCHLIST_DELETE: 'trade.watchlist.delete',
    ALERT_READ: 'trade.alert.read',
    ALERT_CREATE: 'trade.alert.create',
    ALERT_DELETE: 'trade.alert.delete',
});
const PROPOSED = new Set(Object.values(CAPABILITIES));

/** → { allowed, code, reason } like capabilities.check(). */
function checkCapability(claims, capabilityId) {
    if (!capabilities.get(capabilityId) && PROPOSED.has(capabilityId)) {
        return capabilities.grants(claims && claims.cap, capabilityId)
            ? { allowed: true, code: null, reason: null }
            : { allowed: false, code: 'capability.denied', reason: `${capabilityId} not granted` };
    }
    return capabilities.check(claims, capabilityId);
}

module.exports = { CAPABILITIES, PROPOSED, checkCapability };
