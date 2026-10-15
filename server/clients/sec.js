'use strict';

/**
 * SEC EDGAR's XBRL API, read directly: https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json. The host is
 * fixed (never a URL a person chose), so this is not an open fetcher. SEC's fair-access policy asks for a User-Agent
 * that names the requester and gives a contact (TRADE_SEC_USER_AGENT), and at most 10 requests a second: requests
 * here are spaced at least TRADE_SEC_MIN_INTERVAL_MS apart (1 s by default). A body over 40 MB is refused.
 *
 * companyFacts(cik) → { doc, retrievedAt } — doc is null when SEC has no XBRL facts for the company (404).
 */
const BASE = 'https://data.sec.gov/api/xbrl/companyfacts';
const MAX_BYTES = 40 * 1024 * 1024;

function createSec({ config, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
    const enabled = config.sec.enabled;
    let last = 0;
    let chain = Promise.resolve();

    /** One request at a time, at least minIntervalMs after the previous one started. */
    function spaced(fn) {
        const run = chain.then(async () => {
            const wait = last + config.sec.minIntervalMs - now();
            if (wait > 0) await new Promise((r) => setTimeout(r, wait));
            last = now();
            return await fn();
        });
        chain = run.catch(() => {});
        return run;
    }

    async function companyFacts(cik) {
        if (!enabled) throw new Error('SEC facts are off (TRADE_SEC_FACTS=off)');
        const padded = String(cik).replace(/\D/g, '').padStart(10, '0');
        if (!/^\d{10}$/.test(padded)) throw new Error('not a CIK');
        return await spaced(async () => {
            const res = await fetchImpl(`${BASE}/CIK${padded}.json`, {
                headers: { 'User-Agent': config.sec.userAgent, Accept: 'application/json' },
                signal: AbortSignal.timeout(30_000),
                redirect: 'error',
            });
            const retrievedAt = now();
            if (res.status === 404) return { doc: null, retrievedAt };
            if (!res.ok) throw new Error(`SEC answered ${res.status}`);
            const len = Number(res.headers.get('content-length') || 0);
            if (len > MAX_BYTES) throw new Error(`SEC facts too large (${len} bytes)`);
            const text = await res.text();
            if (text.length > MAX_BYTES) throw new Error('SEC facts too large');
            let doc;
            try { doc = JSON.parse(text); } catch { throw new Error('SEC facts are not JSON'); }
            return { doc, retrievedAt };
        });
    }

    return { enabled, companyFacts };
}

module.exports = { createSec };
