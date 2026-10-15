'use strict';

/**
 * OpenVibe.AI seam: run trade.summarize_market_context over what Trade itself recorded for one instrument.
 *
 *   POST {OV_AI_INTERNAL_URL}/api/v1/runs?wait=…  { workflow, input: { instrument, stale_after_hours, sources } }
 *   (this service's token for audience openvibe.ai, capability ai.run.create, namespace trade)
 *
 * Only Trade's own rows go to the model: SEC's filed numbers (observations) and the filings list (documents),
 * each with its dates and source. A failed or unfinished run produces nothing.
 */
const { serviceAuth } = require('openvibe-contracts');

const WORKFLOW = 'trade.summarize_market_context';

class AiError extends Error {
    constructor(code, message, status = 502) { super(message); this.code = code; this.status = status; }
}

function createAi({ config, fetchImpl = globalThis.fetch }) {
    const enabled = Boolean(config.ai.internalUrl && config.oauth.clientSecret);
    const tokens = enabled ? serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.ai', scope: 'ai.run.create', fetchImpl,
    }) : null;

    /** input: { instrument: { symbol, name, exchange }, stale_after_hours, sources: [AI source] } → { runId, model, stub, output } */
    async function run(input) {
        if (!enabled) throw new AiError('ai.not_configured', 'OpenVibe.AI is not configured (OV_AI_INTERNAL_URL)', 503);
        let res;
        try {
            res = await fetchImpl(`${config.ai.internalUrl}/api/v1/runs?wait=${config.ai.waitMs}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(await tokens.authHeaders()) },
                body: JSON.stringify({ workflow: WORKFLOW, input }),
                signal: AbortSignal.timeout(config.ai.waitMs + 5000),
            });
        } catch (err) {
            throw new AiError('ai.unavailable', `OpenVibe.AI is unreachable: ${err.message}`);
        }
        const body = await res.json().catch(() => null);
        if (!res.ok && res.status !== 202) throw new AiError(`ai.http_${res.status}`, `OpenVibe.AI answered ${res.status}${body && body.code ? ` (${body.code})` : ''}`);
        const r = body && body.run;
        if (!r || r.status !== 'succeeded' || !r.output || typeof r.output !== 'object') {
            throw new AiError('ai.no_result', `The ${WORKFLOW} run did not finish with a result (${r ? r.status : 'no run'})`);
        }
        return { runId: String(r.id), model: r.provenance && r.provenance.model ? String(r.provenance.model) : null, stub: Boolean(r.synthetic), output: r.output };
    }

    return { enabled, WORKFLOW, run };
}

module.exports = { createAi, AiError, WORKFLOW };
