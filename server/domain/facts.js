'use strict';

/**
 * A listed company's key numbers from its own SEC filings: EDGAR's XBRL "company facts"
 * (https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json, public domain, the SEC's fair-access
 * policy: a User-Agent that names us and a contact, at most 10 requests a second; Trade makes at most one
 * a second and only when a company files a report or a reader asks).
 *
 * SEC tags one fact per company per calendar period with a `frame` (CY2025 a year, CY2026Q2 a quarter,
 * CY2026Q2I an instant): the fact that period is best described by, already de-duplicated across filings.
 * Only framed facts are read, so a comparative repeated in later reports is never counted twice.
 *
 *   flows     revenue, net income, operating income, diluted EPS, operating cash flow:
 *             the last five quarters (metric <name>.q) and the last two years (<name>.fy)
 *   instants  total assets, total liabilities, stockholders' equity, cash, long-term debt, shares
 *             outstanding: the last five quarter ends (<name>)
 *
 * Each becomes an observation (domain/observations.js): the value exactly as filed, its unit, the period
 * ("3 months to 2026-06-27"), observed_at the period's end, source_key sec-companyfacts and source_ref
 * <CIK>:<accession>:<concept>:<frame> (one observation per filed fact; a restatement under a new accession is a
 * new observation and both stay on record). Nothing is computed here: growth and margins are left to the
 * reader and the AI brief, which cite these rows.
 */
const { iso, parseTime } = require('./helpers');

const SOURCE_KEY = 'sec-companyfacts';
const SOURCE_NAME = 'SEC EDGAR: company financial facts (XBRL)';
const TERMS = 'Public EDGAR data (U.S. Securities and Exchange Commission), public domain. Fair access: a User-Agent naming the requester and a contact, at most 10 requests per second; Trade asks once per company report. Informational only: not investment advice.';
const LICENSE = 'US government work: public domain (17 U.S.C. 105). Cite the U.S. Securities and Exchange Commission.';

/** metric → { label, concepts (first with the newest framed fact wins), unit, kind: flow | instant } */
const METRICS = Object.freeze({
    revenue: { label: 'Revenue', kind: 'flow', unit: 'USD', concepts: ['us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax', 'us-gaap:Revenues', 'us-gaap:SalesRevenueNet', 'us-gaap:RevenueFromContractWithCustomerIncludingAssessedTax'] },
    net_income: { label: 'Net income', kind: 'flow', unit: 'USD', concepts: ['us-gaap:NetIncomeLoss', 'us-gaap:ProfitLoss'] },
    operating_income: { label: 'Operating income', kind: 'flow', unit: 'USD', concepts: ['us-gaap:OperatingIncomeLoss'] },
    eps_diluted: { label: 'Diluted EPS', kind: 'flow', unit: 'USD/shares', concepts: ['us-gaap:EarningsPerShareDiluted'] },
    operating_cash_flow: { label: 'Operating cash flow', kind: 'flow', unit: 'USD', concepts: ['us-gaap:NetCashProvidedByUsedInOperatingActivities'] },
    total_assets: { label: 'Total assets', kind: 'instant', unit: 'USD', concepts: ['us-gaap:Assets'] },
    total_liabilities: { label: 'Total liabilities', kind: 'instant', unit: 'USD', concepts: ['us-gaap:Liabilities'] },
    equity: { label: 'Stockholders\' equity', kind: 'instant', unit: 'USD', concepts: ['us-gaap:StockholdersEquity'] },
    cash: { label: 'Cash and equivalents', kind: 'instant', unit: 'USD', concepts: ['us-gaap:CashAndCashEquivalentsAtCarryingValue'] },
    long_term_debt: { label: 'Long-term debt', kind: 'instant', unit: 'USD', concepts: ['us-gaap:LongTermDebtNoncurrent'] },
    shares_outstanding: { label: 'Shares outstanding', kind: 'instant', unit: 'shares', concepts: ['dei:EntityCommonStockSharesOutstanding'] },
});

const QUARTER = /^CY\d{4}Q[1-4]$/;
const YEAR = /^CY\d{4}$/;
const INSTANT = /^CY\d{4}Q[1-4]I$/;

/** Sort key for a metric: the statement order of METRICS (quarter, then year), then anything else by name. */
function metricOrder(metric) {
    const [base, span] = String(metric).split('.');
    const i = Object.keys(METRICS).indexOf(base);
    return i < 0 ? `9:${metric}` : `${String(i).padStart(2, '0')}:${span === 'q' ? 0 : span === 'fy' ? 1 : 2}`;
}

/** "Revenue (quarter)" for revenue.q; the label for anything else Trade records. */
function labelOf(metric) {
    const [base, span] = String(metric).split('.');
    const m = METRICS[base];
    if (!m) return metric;
    return span === 'q' ? `${m.label} (quarter)` : span === 'fy' ? `${m.label} (year)` : m.label;
}

function periodText(f, span) {
    if (span === 'instant') return `at ${f.end}`;
    return `${span === 'q' ? '3' : '12'} months to ${f.end}`;
}

/** The framed facts of one concept in one unit, newest period first. */
function framed(facts, concept, unit, re) {
    const [ns, name] = concept.split(':');
    const units = facts && facts[ns] && facts[ns][name] && facts[ns][name].units;
    const list = units && Array.isArray(units[unit]) ? units[unit] : [];
    return list.filter((f) => f && typeof f.frame === 'string' && re.test(f.frame) && f.end && f.val != null && f.accn)
        .sort((a, b) => (a.end < b.end ? 1 : a.end > b.end ? -1 : 0));
}

/**
 * companyfacts JSON → [{ metric, label, concept, value, unit, currency, period, end, accn, form, filed, frame }],
 * newest first within each metric. Pure: reads only what the document states.
 */
function extract(doc) {
    const facts = doc && doc.facts;
    if (!facts || typeof facts !== 'object') return [];
    const out = [];
    for (const [name, m] of Object.entries(METRICS)) {
        const spans = m.kind === 'flow' ? [['q', QUARTER, 5], ['fy', YEAR, 2]] : [['instant', INSTANT, 5]];
        for (const [span, re, keep] of spans) {
            // The concept whose newest framed fact is the most recent (companies switch revenue tags over the years).
            let best = null;
            for (const concept of m.concepts) {
                const list = framed(facts, concept, m.unit, re);
                if (list.length && (!best || list[0].end > best.list[0].end)) best = { concept, list };
            }
            if (!best) continue;
            for (const f of best.list.slice(0, keep)) {
                out.push({
                    metric: span === 'instant' ? name : `${name}.${span}`, label: labelOf(span === 'instant' ? name : `${name}.${span}`),
                    concept: best.concept, value: String(f.val), unit: m.unit, currency: m.unit === 'USD' ? 'USD' : null,
                    period: periodText(f, span), end: f.end, accn: String(f.accn), form: f.form || null, filed: f.filed || null, frame: f.frame,
                });
            }
        }
    }
    return out;
}

/** The filing's folder on EDGAR, for a person following the source. */
function filingUrl(cik, accn) {
    return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${String(accn).replace(/-/g, '')}/`;
}

/**
 * ctx: instruments, observations, freshness. sec: { companyFacts(cik) → { doc, retrievedAt } } (clients/sec.js).
 * record(instrument) fetches and records; → { recorded, unchanged, skipped, error? }. Errors are kept in
 * trade_facts_state, never thrown into the caller's loop.
 */
function createFacts({ store, ctx, sec, log = console }) {
    const { db } = store;
    const q = {
        state: db.prepare('SELECT * FROM trade_facts_state WHERE instrument_id = ?'),
        save: db.prepare(`INSERT INTO trade_facts_state (instrument_id, fetched_at, ok, error, observations)
                          VALUES (@id, @at, @ok, @error, @n)
                          ON CONFLICT (instrument_id) DO UPDATE SET fetched_at = @at, ok = @ok, error = @error, observations = @n`),
        // Companies with a new financial report (10-K, 10-Q, 20-F, 40-F and their amendments) since their facts were
        // last read, or never read: oldest report first, so a burst of filings is worked through in order.
        due: db.prepare(`SELECT i.*, MAX(d.retrieved_at) AS report_at FROM trade_instruments i
                           JOIN trade_source_documents d ON d.instrument_id = i.id AND d.removed_at IS NULL
                           LEFT JOIN trade_facts_state s ON s.instrument_id = i.id
                          WHERE i.status = 'active' AND i.cik IS NOT NULL AND d.kind = 'filing'
                            AND d.form_type IN ('10-K', '10-K/A', '10-Q', '10-Q/A', '20-F', '20-F/A', '40-F', '40-F/A')
                            AND (s.fetched_at IS NULL OR d.retrieved_at > s.fetched_at)
                          GROUP BY i.id ORDER BY report_at ASC LIMIT ?`),
    };

    async function record(instrument) {
        if (!instrument || !instrument.cik) return { recorded: 0, unchanged: 0, skipped: 0, error: 'no CIK' };
        let got;
        try {
            got = await sec.companyFacts(instrument.cik);
        } catch (err) {
            await q.save.run({ id: instrument.id, at: store.now(), ok: 0, error: String(err.message).slice(0, 300), n: 0 });
            log.warn(`[Trade] SEC facts for ${instrument.symbol} failed:`, err.message);
            return { recorded: 0, unchanged: 0, skipped: 0, error: err.message };
        }
        const rows = got.doc ? extract(got.doc) : [];
        const retrieved = iso(got.retrievedAt);
        let recorded = 0;
        let unchanged = 0;
        let skipped = 0;
        for (const r of rows) {
            const observedAt = parseTime(`${r.end}T00:00:00Z`);
            if (observedAt == null) { skipped++; continue; }
            try {
                const out = await ctx.observations.record({
                    metric: r.metric, value: r.value, unit: r.unit, currency: r.currency, period: r.period,
                    observed_at: iso(observedAt), retrieved_at: retrieved,
                    source_key: SOURCE_KEY, source_url: filingUrl(instrument.cik, r.accn), source_ref: `${instrument.cik}:${r.accn}:${r.concept}:${r.frame}`,
                }, instrument, { recordedBy: 'svc:trade' });
                if (out.created) recorded++; else unchanged++;
            } catch (err) {
                if (err && (err.status === 409 || err.status === 422)) { skipped++; continue; }
                throw err;
            }
        }
        await q.save.run({ id: instrument.id, at: store.now(), ok: 1, error: got.doc ? null : 'SEC has no XBRL facts for this company', n: rows.length });
        await ctx.freshness.report(SOURCE_KEY, { name: SOURCE_NAME, status: 'ok', lastSuccessAt: got.retrievedAt, staleAfterSec: 7 * 86400, termsNote: TERMS, licenseNote: LICENSE });
        return { recorded, unchanged, skipped };
    }

    return {
        SOURCE_KEY,
        record,
        state: async (instrument) => await q.state.get(instrument.id) || null,
        /** Companies whose facts should be read now (a new report since the last read), at most `limit`. */
        due: async (limit) => await q.due.all(limit),
    };
}

module.exports = { createFacts, extract, labelOf, metricOrder, filingUrl, METRICS, SOURCE_KEY, SOURCE_NAME };
