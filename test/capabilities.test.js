'use strict';
/**
 * The trade.* capabilities are released by openvibe-contracts, so the service guards delegate to the
 * library's grant rule rather than deciding a proposed id locally (the fallback that existed while
 * the ids were only proposals). These pin that: every guarded id is defined by the installed
 * contracts and by the trade service manifest, and checkCapability agrees with capabilities.check
 * for an exact grant, a prefix grant, no grant, and an id the contracts do not define.
 */
const assert = require('assert');
const { capabilities, services } = require('openvibe-contracts');
const { checkCapability, CAPABILITIES } = require('../server/auth/capabilities');
const { check, done } = require('./helpers/boot');

const GRANTED = { cap: ['trade.watchlist.create'], sub: 'svc:tools' };

(async () => {
    await check('every guarded capability is defined by the installed contracts and the trade manifest', async () => {
        const manifest = services.get('trade');
        assert.ok(manifest, 'openvibe-contracts defines the trade service manifest');
        assert.deepStrictEqual([...manifest.capabilities].sort(), Object.values(CAPABILITIES).sort());
        for (const id of Object.values(CAPABILITIES)) {
            const cap = capabilities.get(id);
            assert.ok(cap, `${id} is defined by openvibe-contracts`);
            assert.strictEqual(cap.owner, 'trade', `${id} is owned by trade`);
        }
    });

    await check('checkCapability follows the contracts grant rule (exact, prefix, denied, unknown)', async () => {
        // An exact grant and a `prefix.*` grant the library's matching rule accepts.
        assert.deepStrictEqual(checkCapability(GRANTED, 'trade.watchlist.create'), { allowed: true, code: null, reason: null });
        assert.deepStrictEqual(checkCapability({ cap: ['trade.*'] }, 'trade.watchlist.create'), { allowed: true, code: null, reason: null });
        // A grant of a sibling capability, or no cap at all, is denied with the library's code.
        assert.strictEqual(checkCapability({ cap: ['trade.watchlist.read'] }, 'trade.watchlist.create').code, 'capability.denied');
        assert.strictEqual(checkCapability(null, 'trade.watchlist.create').code, 'capability.denied');
        // An id the contracts do not define still answers capability.unknown — the guard delegates,
        // it never decides an unknown id on its own.
        assert.strictEqual(checkCapability({ cap: ['trade.*'] }, 'trade.not.a.capability').code, 'capability.unknown');
    });

    done();
})().catch((err) => { console.error(err); process.exit(1); });
