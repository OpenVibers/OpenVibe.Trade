'use strict';

/**
 * AI briefs: a short market context for one instrument, written by OpenVibe.AI (trade.summarize_market_context) from
 * what Trade itself recorded — SEC's filed numbers (observations, ./facts.js) and the filings list (documents) — and
 * shown on the instrument page labelled as AI-written and not reviewed by a person.
 *
 *   sources sent     one per metric series (its last values with their periods and accessions) and one per recent
 *                    filing, at most 50; nothing else about the company, and nothing about any reader
 *   kept             the summary, and each point the model tied to a source (a point without a valid citation is
 *                    dropped and listed as a gap); citations become Trade's own { kind, id } refs
 *   refused          text that reads as advice or a recommendation (context.js ADVICE_RE, ADR-025), a stub run, or
 *                    a run with no result: no brief at all, never a partial one
 *   once per input   the inputs' hash is stored; the same numbers and filings make no second brief
 *
 * Briefs are made after a company's report brings new numbers (the worker, trigger 'report') or when a reader asks
 * (POST /i/:symbol/brief, trigger 'reader'), within TRADE_BRIEFS_PER_HOUR for the whole site.
 */
const crypto = require('crypto');
const { ADVICE_RE } = require('./context');
const { labelOf, SOURCE_KEY: FACTS_KEY } = require('./facts');
const { newId, iso } = require('./helpers');
const { ApiError } = require('../http/errors');

const MAX_SOURCES = 50;
const MAX_DOCS = 12;
const PER_SERIES = 7;

function createBriefs({ store, config, ctx, ai, log = console }) {
    const { db } = store;
    const q = {
        latest: db.prepare('SELECT * FROM trade_ai_briefs WHERE instrument_id = ? ORDER BY created_at DESC, id DESC LIMIT 1'),
        recent: db.prepare(`SELECT b.*, i.symbol, i.name FROM trade_ai_briefs b JOIN trade_instruments i ON i.id = b.instrument_id
                            WHERE i.status = 'active' AND b.id = (SELECT id FROM trade_ai_briefs x WHERE x.instrument_id = b.instrument_id ORDER BY created_at DESC, id DESC LIMIT 1)
                            ORDER BY b.created_at DESC LIMIT ?`),
        lastHour: db.prepare('SELECT COUNT(*) AS n FROM trade_ai_briefs WHERE created_at > ?'),
        stats: db.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT instrument_id) AS companies FROM trade_ai_briefs'),
        insert: db.prepare(`INSERT INTO trade_ai_briefs (id, instrument_id, summary, points, cites, gaps, as_of, inputs_hash, run_id, model, trigger, created_at)
                            VALUES (@id, @instrument_id, @summary, @points, @cites, @gaps, @as_of, @inputs_hash, @run_id, @model, @trigger, @created_at)`),
        series: db.prepare(`SELECT * FROM trade_market_observations WHERE instrument_id = ?
                            ORDER BY metric, observed_at DESC, recorded_at DESC`),
        docs: db.prepare(`SELECT * FROM trade_source_documents WHERE instrument_id = ? AND removed_at IS NULL
                          ORDER BY COALESCE(published_at, retrieved_at) DESC LIMIT ?`),
        // Companies whose numbers were read after their last brief (or that have none): a report brought new numbers.
        due: db.prepare(`SELECT i.* FROM trade_instruments i JOIN trade_facts_state s ON s.instrument_id = i.id
                          WHERE i.status = 'active' AND s.ok = 1 AND s.observations > 0
                            AND NOT EXISTS (SELECT 1 FROM trade_ai_briefs b WHERE b.instrument_id = i.id AND b.created_at >= s.fetched_at)
                          ORDER BY s.fetched_at ASC LIMIT ?`),
    };

    const fmtDay = (t) => (t == null ? 'no date' : new Date(Number(t)).toISOString().slice(0, 10));

    /** The model's sources, in citation order, and what each one cites on Trade's side. */
    async function inputsFor(instrument) {
        const sources = [];
        const refs = [];
        const groups = new Map();
        for (const o of await q.series.all(instrument.id)) {
            const key = `${o.metric}|${o.unit}`;
            if (!groups.has(key)) groups.set(key, []);
            const g = groups.get(key);
            // One value per period (a restatement under a later accession is newer: the first row seen is kept).
            if (g.length < PER_SERIES && !g.some((x) => x.observed_at === o.observed_at && (x.period || '') === (o.period || ''))) g.push(o);
        }
        for (const rows of groups.values()) {
            if (sources.length >= MAX_SOURCES - MAX_DOCS) break;
            const o = rows[0];
            const fromSec = o.source_key === FACTS_KEY;
            sources.push({
                source_type: fromSec ? 'trade.sec_fact' : 'trade.observation',
                source_id: o.id,
                title: `${instrument.symbol}: ${labelOf(o.metric)}${fromSec ? ', from SEC filings' : ''}`,
                observed_at: iso(o.observed_at),
                retrieved_at: iso(o.retrieved_at),
                ...(o.source_url ? { url: o.source_url } : {}),
                content: rows.map((r) => `${r.period || iso(r.observed_at)}: ${r.value} ${r.unit}${fromSec ? ` (filing ${String(r.source_ref).split(':')[1]})` : ` (${r.source_key})`}`).join('\n'),
                provenance: { service: 'trade', source_key: o.source_key },
            });
            // Cited by its newest row: the one the page's observations table shows, so each citation links to a row on the page.
            refs.push([{ kind: 'observation', id: o.id, at: o.observed_at }]);
        }
        for (const d of await q.docs.all(instrument.id, MAX_DOCS)) {
            if (sources.length >= MAX_SOURCES) break;
            sources.push({
                source_type: d.kind === 'filing' ? 'trade.sec_filing' : 'trade.document',
                source_id: d.id,
                title: `${d.form_type ? `${d.form_type}: ` : ''}${d.title || d.filer_name || 'document'}`,
                ...(d.published_at ? { published_at: iso(d.published_at) } : {}),
                retrieved_at: iso(d.retrieved_at),
                ...(d.url ? { url: d.url } : {}),
                snippet: `${d.form_type || 'Document'} filed ${fmtDay(d.published_at)}${d.accession ? `, accession ${d.accession}` : ''}.`,
                provenance: { service: 'trade', source_key: d.source_key },
            });
            refs.push([{ kind: 'document', id: d.id, at: d.published_at || d.retrieved_at }]);
        }
        const hash = crypto.createHash('sha256').update(JSON.stringify(sources.map((s) => [s.source_id, s.content || s.snippet]))).digest('hex');
        return { sources, refs, hash };
    }

    const lastHour = async () => (await q.lastHour.get(store.now() - 3600_000)).n;

    /**
     * Write a brief for the instrument now. → { brief, created } (created false: the inputs are unchanged since the
     * last brief). Throws ApiError: 409 nothing to write from, 429 the hourly budget is spent, 422 advice refused,
     * 502/503 OpenVibe.AI.
     */
    async function make(instrument, { trigger = 'report' } = {}) {
        const { sources, refs, hash } = await inputsFor(instrument);
        if (!sources.length) throw new ApiError(409, 'brief.no_inputs', `Trade has no SEC numbers or filings for ${instrument.symbol} yet, so there is nothing to write a brief from`);
        const prior = await q.latest.get(instrument.id);
        if (prior && prior.inputs_hash === hash) return { brief: view(prior), created: false };
        if (await lastHour() >= config.briefs.perHour) throw new ApiError(429, 'brief.budget', 'The AI briefs budget for this hour is used up; try again later');

        let r;
        try {
            r = await ai.run({
                instrument: { symbol: instrument.symbol, name: String(instrument.name).slice(0, 200), ...(instrument.exchange ? { exchange: instrument.exchange } : {}) },
                stale_after_hours: 24 * 120,
                sources,
            });
        } catch (err) {
            throw new ApiError(err.status || 502, err.code || 'ai.error', `No AI brief: ${err.message}`);
        }
        if (r.stub) throw new ApiError(503, 'brief.stub', 'OpenVibe.AI answered with a placeholder (no model is configured); no brief was made');
        const out = r.output || {};
        const gaps = Array.isArray(out.gaps) ? out.gaps.map((g) => String(g).slice(0, 300)).slice(0, 20) : [];
        const citeRefs = (list) => {
            const seen = new Set();
            const got = [];
            for (const n of Array.isArray(list) ? list : []) {
                if (!Number.isInteger(n) || n < 0 || n >= refs.length) continue;
                for (const ref of refs[n]) {
                    const k = `${ref.kind}:${ref.id}`;
                    if (!seen.has(k)) { seen.add(k); got.push(ref); }
                }
            }
            return got;
        };
        const summary = String(out.summary || '').trim().slice(0, 3000);
        const points = [];
        for (const p of Array.isArray(out.observations) ? out.observations : []) {
            const text = String(p && p.text || '').trim().slice(0, 600);
            if (!text) continue;
            const cites = citeRefs(p.citations);
            if (!cites.length) { gaps.push(`Left out (no source cited): ${text.slice(0, 200)}`); continue; }
            points.push({ text, observed_at: p.observed_at ? String(p.observed_at).slice(0, 40) : null, cites: cites.map(({ kind, id }) => ({ kind, id })) });
        }
        if (!summary && !points.length) throw new ApiError(502, 'brief.empty', 'OpenVibe.AI returned no text it could support from the sources');
        if (ADVICE_RE.test(summary) || points.some((p) => ADVICE_RE.test(p.text))) {
            log.warn(`[Trade] AI brief for ${instrument.symbol} refused: it read as advice`);
            throw new ApiError(422, 'brief.advice_refused', 'The AI text read as investment advice, so it was not kept (Trade publishes information only)');
        }
        const all = citeRefs(out.citations).concat(points.flatMap((p) => p.cites.map((c) => refs.flat().find((x) => x.kind === c.kind && x.id === c.id))).filter(Boolean));
        const cites = [];
        const seen = new Set();
        let asOf = null;
        for (const c of all) {
            const k = `${c.kind}:${c.id}`;
            if (seen.has(k)) continue;
            seen.add(k);
            cites.push({ kind: c.kind, id: c.id });
            if (c.at != null && (asOf == null || c.at > asOf)) asOf = c.at;
        }
        const row = {
            id: newId('tbr', store.now()), instrument_id: instrument.id, summary, points: JSON.stringify(points), cites: JSON.stringify(cites),
            gaps: JSON.stringify(gaps.slice(0, 20)), as_of: asOf, inputs_hash: hash, run_id: r.runId, model: r.model, trigger, created_at: store.now(),
        };
        await q.insert.run(row);
        return { brief: view(await q.latest.get(instrument.id)), created: true };
    }

    const parse = (v, d) => { if (v == null) return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return d; } };

    function view(row) {
        if (!row) return null;
        return {
            id: row.id, summary: row.summary, points: parse(row.points, []), cites: parse(row.cites, []), gaps: parse(row.gaps, []),
            as_of: iso(row.as_of), created_at: iso(row.created_at), model: row.model || null, trigger: row.trigger,
            authorship: { kind: 'ai', reviewed: false, workflow: ai.WORKFLOW, run_id: row.run_id || null },
            disclaimer: 'Written by OpenVibe.AI from the SEC numbers and filings on this page, not reviewed by a person. Informational only; not investment advice.',
            ...(row.symbol ? { symbol: row.symbol, name: row.name } : {}),
        };
    }

    return {
        enabled: ai.enabled,
        make,
        inputsFor,
        latest: async (instrument) => view(await q.latest.get(instrument.id)),
        recent: async (limit = 8) => (await q.recent.all(limit)).map(view),
        /** { briefs written, companies with one } */
        stats: async () => { const r = await q.stats.get(); return { total: Number(r.n), companies: Number(r.companies) }; },
        due: async (limit) => await q.due.all(limit),
        lastHour,
    };
}

module.exports = { createBriefs };
