'use strict';

/**
 * Capability checks for service tokens (audience openvibe.trade). The trade.* ids this service
 * introduces are defined by the installed openvibe-contracts, so a grant is decided by the
 * library's own matching rule (the exact id, or a `prefix.*` grant covering it). CAPABILITIES keeps
 * the ids in one place for the guards, the proposal documents and the tests.
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

/** → { allowed, code, reason } like capabilities.check(). */
function checkCapability(claims, capabilityId) {
    return capabilities.check(claims, capabilityId);
}

module.exports = { CAPABILITIES, checkCapability };
