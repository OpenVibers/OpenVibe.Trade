'use strict';

/**
 * OpenVibe.Sources, read with Trade's service token (audience openvibe.sources):
 *   sources.item.read     GET /api/v1/items?category=trade&after=<change_seq>&include_removed=1
 *   sources.source.read   GET /api/v1/sources   (health and staleness of every source)
 * Off until OV_OAUTH_CLIENT_SECRET is set. A failure is an error for the caller to record, never an
 * empty answer.
 */
const { serviceAuth } = require('openvibe-contracts');

function createSourcesClient({ config, fetchImpl = globalThis.fetch }) {
    const enabled = Boolean(config.oauth.clientSecret && config.sources.internalUrl);
    const tokens = enabled ? serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.sources', scope: 'sources.item.read sources.source.read', fetchImpl,
    }) : null;

    async function get(path) {
        if (!enabled) throw new Error('Sources client disabled (OV_OAUTH_CLIENT_SECRET unset)');
        const res = await fetchImpl(`${config.sources.internalUrl}${path}`, {
            headers: { Accept: 'application/json', ...(await tokens.authHeaders()) },
            signal: AbortSignal.timeout(15_000),
        });
        if (res.status === 401 && tokens.invalidate) tokens.invalidate();
        const data = await res.json().catch(() => null);
        if (!res.ok || !data) {
            const err = new Error(`Sources answered ${res.status}${data && data.code ? ` (${data.code})` : ''} for ${path.split('?')[0]}`);
            err.status = res.status;
            throw err;
        }
        return data;
    }

    return {
        enabled,
        items: ({ after = 0, limit = 200 } = {}) => get(`/api/v1/items?category=${encodeURIComponent(config.sources.category)}&after=${after}&limit=${limit}&include_removed=1`),
        sources: () => get('/api/v1/sources'),
    };
}

module.exports = { createSourcesClient };
