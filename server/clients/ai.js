'use strict';

/**
 * OpenVibe.AI seam: run trade.summarize_market_context over what Trade itself recorded for one instrument.
 *
 *   POST {OV_AI_INTERNAL_URL}/api/v1/runs?wait=…  { workflow, input: { instrument, stale_after_hours, sources } }
 *   (this service's token for audience openvibe.ai, capability ai.run.create, namespace trade)
 *
 * The worker's report briefs ask for the `batch` latency class (options.latency 'batch', options.deadline_hours):
 * the run is created now and answered through OpenVibe.AI's provider batch queue, so Trade keeps the run id and
 * collects the answer on a later tick. A reader's ask stays synchronous: the person is waiting on the page.
 * A batch refused at the door, or a run that ends without an answer, falls back to the background class once.
 *
 * Only Trade's own rows go to the model: SEC's filed numbers (observations) and the filings list (documents),
 * each with its dates and source. A failed or unfinished run produces nothing.
 */
const { serviceAuth } = require('openvibe-contracts');

const WORKFLOW = 'trade.summarize_market_context';
const DONE = new Set(['succeeded', 'cached']);
const FAILED = new Set(['failed', 'cancelled', 'expired']);

class AiError extends Error {
    constructor(code, message, status = 502) { super(message); this.code = code; this.status = status; }
}

function createAi({ config, fetchImpl = globalThis.fetch }) {
    const enabled = Boolean(config.ai.internalUrl && config.oauth.clientSecret);
    const tokens = enabled ? serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.ai', scope: 'ai.run.create', fetchImpl,
    }) : null;

    /**
     * One JSON request to OpenVibe.AI. → { status, ok, body }. A stale service token is refetched once.
     * The body is kept even on an error response: the AI service's problem+json names the refusal.
     */
    async function request(method, path, body, timeoutMs, retried = false) {
        if (!enabled) throw new AiError('ai.not_configured', 'OpenVibe.AI is not configured (OV_AI_INTERNAL_URL)', 503);
        let headers;
        try { headers = await tokens.authHeaders(); } catch (err) { throw new AiError('ai.auth', `OpenVibe.AI token: ${err.message}`, 503); }
        let res;
        try {
            res = await fetchImpl(`${config.ai.internalUrl}${path}`, {
                method,
                headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
                body: body ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (err) {
            throw new AiError('ai.unavailable', `OpenVibe.AI is unreachable: ${err.message}`);
        }
        const json = await res.json().catch(() => null);
        if (res.status === 401 && !retried) { tokens.invalidate(); return await request(method, path, body, timeoutMs, true); }
        return { status: res.status, ok: res.ok, body: json };
    }

    /** A run as Trade reads it: the id, its status, its answer, and the model or error it carries. */
    function runView(r) {
        if (!r || !r.id) return null;
        return {
            runId: String(r.id), status: String(r.status || 'queued'),
            model: r.provenance && r.provenance.model ? String(r.provenance.model) : null,
            stub: Boolean(r.synthetic), output: r.output && typeof r.output === 'object' ? r.output : null,
            error: r.error || null,
        };
    }

    /**
     * Run a workflow and wait for it. `latency: 'background'` asks for the class that may wait minutes (the
     * workflow's own class is background); it is how a refused or expired batch falls back once. An
     * idempotencyKey makes a retried fallback return the same run instead of a second one.
     */
    async function run(input, { latency = null, idempotencyKey = null } = {}) {
        const body = { workflow: WORKFLOW, input };
        if (latency) body.options = { latency };
        if (idempotencyKey) body.idempotency_key = idempotencyKey;
        const send = () => request('POST', `/api/v1/runs?wait=${config.ai.waitMs}`, body, config.ai.waitMs + 5000);
        let out;
        try { out = await send(); } catch (err) {
            // A retried create with the same idempotency key is the same run: a timeout that lost the answer
            // must not become a second paid run.
            if (err.code !== 'ai.unavailable' || !idempotencyKey) throw err;
            out = await send();
        }
        if (!out.ok && out.status !== 202) {
            throw new AiError(`ai.http_${out.status}`, `OpenVibe.AI answered ${out.status}${out.body && out.body.code ? ` (${out.body.code})` : ''}`);
        }
        const r = runView(out.body && out.body.run);
        if (!r || !DONE.has(r.status) || !r.output) {
            throw new AiError('ai.no_result', `The ${WORKFLOW} run did not finish with a result (${r ? r.status : 'no run'})`);
        }
        return r;
    }

    /**
     * Queue a workflow run in the batch class and return its id at once; the answer is collected later.
     * → { runId, status, model, stub, output, error, done } (done: it answered inside the call, e.g. a cache hit).
     */
    async function start(input, { deadlineHours = 24, idempotencyKey = null } = {}) {
        const hours = Math.max(1, Math.min(72, Math.trunc(Number(deadlineHours) || 24)));
        const body = { workflow: WORKFLOW, input, options: { latency: 'batch', deadline_hours: hours } };
        if (idempotencyKey) body.idempotency_key = idempotencyKey;
        const send = () => request('POST', '/api/v1/runs?wait=0', body, Math.max(20000, config.ai.waitMs));
        let out;
        try { out = await send(); } catch (err) {
            // The run may have been created before the connection broke. The same key replays it, so retry once
            // before the caller falls back and pays for a second run.
            if (err.code !== 'ai.unavailable') throw err;
            out = await send();
        }
        if (!out.ok && out.status !== 202) {
            throw new AiError(`ai.http_${out.status}`, `OpenVibe.AI answered ${out.status}${out.body && out.body.code ? ` (${out.body.code})` : ''}`);
        }
        const r = runView(out.body && out.body.run);
        if (!r) throw new AiError('ai.no_run', 'OpenVibe.AI did not answer a run for the batch');
        return { ...r, done: DONE.has(r.status) };
    }

    /** One run by id; null when OpenVibe.AI has no such run (404). */
    async function get(runId) {
        const out = await request('GET', `/api/v1/runs/${encodeURIComponent(runId)}`, null, 15000);
        if (out.status === 404) return null;
        if (!out.ok) throw new AiError(`ai.http_${out.status}`, `OpenVibe.AI answered ${out.status}`);
        return runView(out.body && out.body.run);
    }

    return { enabled, WORKFLOW, run, start, get, DONE, FAILED };
}

module.exports = { createAi, AiError, WORKFLOW };
