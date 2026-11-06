'use strict';

/**
 * The market brief: one AI-written, market-wide summary a day, from what Trade already holds —
 *
 *   the day's filings      form type → how many were published or first seen in the last 24 hours, each to
 *                          /filings?form=… (the same query the page lists)
 *   the euro reference rates
 *                          each currency's newest rate and the previous one from the same source, to its page
 *   the companies with new filings or SEC figures
 *                          one source per company, with what arrived, to /i/SYMBOL
 *   watchlist activity     aggregate additions only, when there are any; no owner or watchlist name leaves Trade
 *   nothing else           no prices (Trade has no licensed price data), no reader data
 *
 * OpenVibe.AI writes it through the same seam and workflow as the per-instrument briefs (clients/ai.js,
 * trade.summarize_market_context). Every point must cite a Trade page (a point without a link is dropped and listed
 * as a gap), and the text is refused if it reads as advice. One brief per UTC day at most: the daily cap is the
 * brief_date unique key, so a restart or a reader never makes a second AI call that day.
 *
 * The brief is AI-written until an editor approves it (trade_market_brief_reviews, append-only). Each brief has its
 * own page at /market/<YYYY-MM-DD>, whose own indexability runs through the shared gate
 * (openvibe-publishing/seo) with the brief's authorship: unreviewed → noindex, reviewed → indexable. The home never
 * changes indexability because of a brief: it shows the latest reviewed one in full and, while none is reviewed,
 * one line linking to the unreviewed page. Without OpenVibe.AI (no URL or no client secret) nothing is made, nothing
 * is shown and nothing fails.
 */
const crypto = require('crypto');
const { ADVICE_RE } = require('./context');
const { newId, iso } = require('./helpers');
const { ApiError } = require('../http/errors');

const DAY = 24 * 3600 * 1000;
const MAX_SOURCES = 50;
const MAX_FORMS = 8;
const MAX_INSTRUMENTS = 12;
const SOURCE_NAME = { 'ecb-euro-reference-rates': 'European Central Bank', 'frankfurter-eur-rates': 'Frankfurter (ECB data)' };

function createMarketBriefs({ store, config, ctx, ai, log = console }) {
    const { db } = store;
    const enabled = Boolean(config.marketBriefs.enabled && ai.enabled);

    const q = {
        byDate: db.prepare('SELECT * FROM trade_market_briefs WHERE brief_date = ?'),
        byId: db.prepare('SELECT * FROM trade_market_briefs WHERE id = ?'),
        latest: db.prepare('SELECT * FROM trade_market_briefs ORDER BY brief_date DESC, created_at DESC, id DESC LIMIT 1'),
        latestReviewed: db.prepare(`SELECT b.* FROM trade_market_briefs b JOIN trade_market_brief_reviews r ON r.brief_id = b.id
                                    WHERE r.decision = 'approved' ORDER BY b.brief_date DESC, b.created_at DESC, b.id DESC LIMIT 1`),
        latestUnreviewed: db.prepare(`SELECT b.* FROM trade_market_briefs b LEFT JOIN trade_market_brief_reviews r ON r.brief_id = b.id
                                      WHERE r.id IS NULL ORDER BY b.brief_date DESC, b.created_at DESC, b.id DESC LIMIT 1`),
        // For the pages sitemap: the reviewed briefs' own /market/<date> pages, no review lookup per row.
        reviewed: db.prepare(`SELECT b.brief_date, b.created_at FROM trade_market_briefs b JOIN trade_market_brief_reviews r ON r.brief_id = b.id
                              WHERE r.decision = 'approved' ORDER BY b.brief_date DESC LIMIT ?`),
        latestReview: db.prepare('SELECT * FROM trade_market_brief_reviews WHERE brief_id = ? ORDER BY id DESC LIMIT 1'),
        insert: db.prepare(`INSERT INTO trade_market_briefs (id, brief_date, summary, points, cites, gaps, as_of, inputs_hash, run_id, model, trigger, created_at)
                            VALUES (@id, @brief_date, @summary, @points, @cites, @gaps, @as_of, @inputs_hash, @run_id, @model, @trigger, @created_at)`),
        insertReview: db.prepare(`INSERT INTO trade_market_brief_reviews (brief_id, reviewer, decision, note, reviewed_at)
                                  VALUES (@brief_id, @reviewer, @decision, @note, @reviewed_at)`),
        // The companies with a filing or a newly read SEC figure in the window: one source each, the newest first.
        instruments: db.prepare(`SELECT * FROM (
                            SELECT i.id, i.symbol, i.name,
                                   (SELECT COUNT(*) FROM trade_source_documents d
                                     WHERE d.instrument_id = i.id AND d.removed_at IS NULL
                                       AND COALESCE(d.published_at, d.first_seen_at) > @since) AS docs,
                                   (SELECT string_agg(DISTINCT d.form_type, ', ' ORDER BY d.form_type) FROM trade_source_documents d
                                     WHERE d.instrument_id = i.id AND d.removed_at IS NULL AND d.form_type IS NOT NULL
                                       AND COALESCE(d.published_at, d.first_seen_at) > @since) AS forms,
                                   (SELECT COUNT(*) FROM trade_market_observations o
                                     WHERE o.instrument_id = i.id AND o.source_key = 'sec-companyfacts' AND o.recorded_at > @since) AS facts,
                                   (SELECT MAX(o.recorded_at) FROM trade_market_observations o
                                     WHERE o.instrument_id = i.id AND o.source_key = 'sec-companyfacts' AND o.recorded_at > @since) AS newest_fact,
                                   (SELECT MAX(COALESCE(d.published_at, d.first_seen_at)) FROM trade_source_documents d
                                     WHERE d.instrument_id = i.id AND d.removed_at IS NULL
                                       AND COALESCE(d.published_at, d.first_seen_at) > @since) AS newest_doc
                              FROM trade_instruments i
                             WHERE i.status = 'active' AND i.kind <> 'currency') x
                            WHERE x.docs > 0 OR x.facts > 0
                            ORDER BY GREATEST(COALESCE(x.newest_doc, 0), COALESCE(x.newest_fact, 0)) DESC, x.symbol
                            LIMIT @limit`),
        watchlistAdds: db.prepare('SELECT COUNT(*) AS n FROM trade_watchlist_items WHERE added_at > ?'),
    };

    const dayOf = (t) => new Date(Number(t)).toISOString().slice(0, 10);
    const day = (t) => (t == null ? 'no date' : new Date(Number(t)).toISOString().slice(0, 10));
    const parse = (v, d) => { if (v == null) return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return d; } };

    const MAJOR = ['USD', 'GBP', 'JPY', 'CHF', 'CNY', 'CAD', 'AUD', 'INR', 'KRW', 'MXN', 'BRL', 'SEK'];
    const rateRank = (r) => (MAJOR.includes(r.symbol) ? MAJOR.indexOf(r.symbol) : MAJOR.length);

    /**
     * The numbered sources OpenVibe.AI reads and, for each, the Trade page a claim about it links to.
     * → { sources, refs, hash, asOf }. Only stored rows: no fetch here.
     */
    async function inputsFor(now) {
        const since = now - DAY;
        const sources = [];
        const refs = [];
        const add = (source, ref) => { sources.push(source); refs.push(ref); };

        for (const f of (await ctx.documents.formCounts(since)).slice(0, MAX_FORMS)) {
            if (sources.length >= MAX_SOURCES) break;
            const url = `/filings?form=${encodeURIComponent(f.form_type)}`;
            add({
                source_type: 'trade.filings_by_form',
                source_id: `form:${f.form_type}`,
                title: `${f.form_type} filings in the last 24 hours`,
                retrieved_at: iso(now),
                url,
                snippet: `${f.count} ${f.form_type} filings were published or first seen in the last 24 hours.`,
                provenance: { service: 'trade', source_key: 'trade.documents' },
            }, { url, label: `${f.form_type} filings`, at: now });
        }

        const rates = (await ctx.observations.rates()).sort((a, b) => rateRank(a) - rateRank(b) || a.symbol.localeCompare(b.symbol));
        for (const r of rates) {
            if (sources.length >= MAX_SOURCES) break;
            const latest = r.latest;
            const url = ctx.urls.path.instrument({ symbol: r.symbol });
            const content = `1 EUR = ${latest.value} ${r.symbol} on ${day(latest.observed_at)}${r.previous ? `, from ${r.previous.value} on ${day(r.previous.observed_at)}` : ''} (${SOURCE_NAME[latest.source_key] || latest.source_key}).`;
            add({
                source_type: 'trade.rate',
                source_id: `rate:${r.symbol}`,
                title: `EUR/${r.symbol} reference rate`,
                observed_at: iso(latest.observed_at),
                retrieved_at: iso(now),
                url,
                snippet: content,
                provenance: { service: 'trade', source_key: latest.source_key },
            }, { url, label: `EUR/${r.symbol}`, at: latest.observed_at });
        }

        for (const i of await q.instruments.all({ since, limit: MAX_INSTRUMENTS })) {
            if (sources.length >= MAX_SOURCES) break;
            const parts = [];
            if (Number(i.docs) > 0) parts.push(`${i.docs} new filing${Number(i.docs) === 1 ? '' : 's'}${i.forms ? ` (${i.forms})` : ''}`);
            if (Number(i.facts) > 0) parts.push(`${Number(i.facts)} new SEC figure${Number(i.facts) === 1 ? '' : 's'}`);
            const url = ctx.urls.path.instrument(i);
            const newest = Math.max(Number(i.newest_doc) || 0, Number(i.newest_fact) || 0, since);
            add({
                source_type: 'trade.instrument',
                source_id: `instrument:${i.id}`,
                title: `${i.symbol} — ${i.name}`,
                retrieved_at: iso(now),
                url,
                snippet: `${i.symbol}: ${parts.join(' and ')} in the last 24 hours.`,
                provenance: { service: 'trade', source_key: 'trade.instruments' },
            }, { url, label: i.symbol, at: newest });
        }

        // Aggregate only: a count can be a market signal, an owner or a watchlist name never leaves Trade.
        const adds = Number((await q.watchlistAdds.get(since)).n);
        if (adds > 0 && sources.length < MAX_SOURCES) {
            add({
                source_type: 'trade.watchlists',
                source_id: 'watchlist-activity',
                title: 'Watchlist activity in the last 24 hours',
                retrieved_at: iso(now),
                url: '/watchlists',
                snippet: `${adds} instrument${adds === 1 ? ' was' : 's were'} added to people's private watchlists in the last 24 hours (aggregate only; no owner or watchlist name is included).`,
                provenance: { service: 'trade', source_key: 'trade.watchlists' },
            }, { url: '/watchlists', label: 'watchlist activity', at: now });
        }

        const hash = crypto.createHash('sha256').update(JSON.stringify(sources.map((s) => [s.source_id, s.snippet]))).digest('hex');
        const asOf = refs.reduce((a, r) => (r.at != null && (a == null || r.at > a) ? r.at : a), null);
        return { sources, refs, hash, asOf };
    }

    /** → the public shape, with the person's latest review if there is one. */
    async function shape(row) {
        if (!row) return null;
        const review = await q.latestReview.get(row.id);
        const reviewed = Boolean(review && review.decision === 'approved' && /^usr_/.test(String(review.reviewer)));
        const rejected = Boolean(review && review.decision === 'rejected');
        return {
            id: row.id,
            date: row.brief_date,
            summary: row.summary,
            points: parse(row.points, []),
            cites: parse(row.cites, []),
            gaps: parse(row.gaps, []),
            as_of: iso(row.as_of),
            created_at: iso(row.created_at),
            model: row.model || null,
            status: reviewed ? 'reviewed' : rejected ? 'rejected' : 'unreviewed',
            reviewed,
            authorship: { kind: 'ai', reviewed, workflow: ai.WORKFLOW, run_id: row.run_id || null },
            disclaimer: 'Written by OpenVibe.AI from what OpenVibe.Trade recorded in the last 24 hours. Informational only; not investment advice.',
        };
    }

    /**
     * Write today's brief, at most once a UTC day. → { brief, created }; brief null when OpenVibe.AI is off or there
     * is nothing stored to write from. Throws ApiError: 422 advice refused, 502/503 OpenVibe.AI (the worker catches
     * these; a page never calls this).
     */
    async function make({ trigger = 'schedule' } = {}) {
        if (!enabled) return { brief: null, created: false };
        const now = store.now();
        const existing = await q.byDate.get(dayOf(now));
        if (existing) return { brief: await shape(existing), created: false };

        const { sources, refs, hash, asOf } = await inputsFor(now);
        if (!sources.length) return { brief: null, created: false };

        let r;
        try {
            // The same workflow as an instrument brief: a market-wide "instrument" so the model knows the scale, and
            // the day's rows as its numbered sources.
            r = await ai.run({
                instrument: { symbol: 'MARKET', name: 'The US market: every company Trade covers' },
                stale_after_hours: 24,
                sources,
            });
        } catch (err) {
            throw new ApiError(err.status || 502, err.code || 'ai.error', `No market brief: ${err.message}`);
        }
        if (r.stub) throw new ApiError(503, 'market_brief.stub', 'OpenVibe.AI answered with a placeholder (no model is configured); no market brief was made');
        const out = r.output || {};
        const gaps = Array.isArray(out.gaps) ? out.gaps.map((g) => String(g).slice(0, 300)).slice(0, 20) : [];

        const cite = (list) => {
            const seen = new Set();
            const got = [];
            for (const n of Array.isArray(list) ? list : []) {
                if (!Number.isInteger(n) || n < 0 || n >= refs.length) continue;
                const ref = refs[n];
                if (seen.has(ref.url)) continue;
                seen.add(ref.url);
                got.push({ url: ref.url, label: ref.label });
            }
            return got;
        };

        const summary = String(out.summary || '').trim().slice(0, 3000);
        const points = [];
        for (const p of Array.isArray(out.observations) ? out.observations : []) {
            const text = String(p && p.text || '').trim().slice(0, 600);
            if (!text) continue;
            const cites = cite(p.citations);
            if (!cites.length) { gaps.push(`Left out (no source link): ${text.slice(0, 200)}`); continue; }
            points.push({ text, cites });
        }
        if (!summary && !points.length) throw new ApiError(502, 'market_brief.empty', 'OpenVibe.AI returned no text it could support from the sources');
        if (ADVICE_RE.test(summary) || points.some((p) => ADVICE_RE.test(p.text))) {
            log.warn('[Trade] market brief refused: it read as advice');
            throw new ApiError(422, 'market_brief.advice_refused', 'The AI text read as investment advice, so it was not kept (Trade publishes information only)');
        }
        const cites = [];
        const seen = new Set();
        for (const c of cite(out.citations).concat(points.flatMap((p) => p.cites))) {
            if (seen.has(c.url)) continue;
            seen.add(c.url);
            cites.push(c);
        }
        if (!cites.length) throw new ApiError(502, 'market_brief.unsourced', 'OpenVibe.AI returned a brief whose claims do not link to any Trade page');

        await q.insert.run({
            id: newId('tmk', now), brief_date: dayOf(now), summary, points: JSON.stringify(points), cites: JSON.stringify(cites),
            gaps: JSON.stringify(gaps.slice(0, 20)), as_of: asOf, inputs_hash: hash, run_id: r.runId, model: r.model,
            trigger, created_at: now,
        });
        return { brief: await shape(await q.byDate.get(dayOf(now))), created: true };
    }

    /** Make today's brief if it is due; never throws (the worker calls this). */
    async function tick() {
        if (!enabled) return null;
        try {
            return await make({ trigger: 'schedule' });
        } catch (err) {
            log.warn(`[Trade] market brief not made: ${err.message}`);
            return null;
        }
    }

    /** The latest brief a reader may see: none without OpenVibe.AI, and none while the latest was rejected. */
    async function latest() {
        if (!enabled) return null;
        const row = await q.latest.get();
        if (!row) return null;
        const brief = await shape(row);
        return brief.status === 'rejected' ? null : brief;
    }

    /** The latest brief a person approved: the only one the home shows in full. */
    async function latestReviewed() {
        if (!enabled) return null;
        const row = await q.latestReviewed.get();
        if (!row) return null;
        const brief = await shape(row);
        return brief.reviewed ? brief : null;
    }

    /** The latest brief still waiting for a person: the home links to it but never shows it. */
    async function latestUnreviewed() {
        if (!enabled) return null;
        const row = await q.latestUnreviewed.get();
        return row ? await shape(row) : null;
    }

    /** One brief by its UTC date, for /market/<YYYY-MM-DD>; rejected briefs are not shown. */
    async function get(date) {
        if (!enabled) return null;
        const row = await q.byDate.get(String(date || ''));
        if (!row) return null;
        const brief = await shape(row);
        return brief.status === 'rejected' ? null : brief;
    }

    /** The reviewed brief pages for the pages sitemap: [{ date, created_at }], newest first. */
    async function reviewed(limit = 100) {
        if (!enabled) return [];
        const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
        return (await q.reviewed.all(n)).map((r) => ({ date: r.brief_date, created_at: iso(r.created_at) }));
    }

    /** The gate facts for a brief's own page: unreviewed AI content is noindex. */
    const gateFacts = (brief) => (brief ? { authorship: { mode: 'ai', reviewed: brief.reviewed } } : {});

    /** The market brief waiting for a person, for GET /api/v1/review-queue. Only the latest one is shown. */
    async function pendingReviews() {
        if (!enabled) return [];
        const row = await q.latest.get();
        if (!row || await q.latestReview.get(row.id)) return [];
        return [{
            site: 'trade', kind: 'market_brief', id: row.id,
            title: `Market brief, ${row.brief_date}`,
            revision: 1, state: 'draft',
            url: `/market/${row.brief_date}`, editUrl: `/market/${row.brief_date}`,
            createdAt: iso(row.created_at),
            reasons: [{ code: 'ai_generated_unreviewed', effect: 'noindex', detail: 'the market brief is an AI draft', text: 'AI-written and not yet reviewed by a person.' }],
            review: { method: 'POST', path: `/api/v1/market-briefs/${encodeURIComponent(row.id)}/review` },
        }];
    }

    /** Record a person's review of one brief. → the brief as shaped. */
    async function review(viewer, id, { decision, note = null } = {}) {
        if (decision !== 'approved' && decision !== 'rejected') throw new ApiError(422, 'review.invalid', 'decision must be approved or rejected');
        const reviewer = viewer && viewer.subject;
        if (!/^usr_/.test(String(reviewer))) throw new ApiError(403, 'review.person_only', 'Only a person can review an AI-written brief');
        const row = await q.byId.get(String(id || ''));
        if (!row) throw new ApiError(404, 'market_brief.not_found', 'No such market brief');
        if (await q.latestReview.get(row.id)) throw new ApiError(409, 'review.already', 'This market brief has already been reviewed');
        await q.insertReview.run({ brief_id: row.id, reviewer, decision, note: note == null ? null : String(note).slice(0, 2000), reviewed_at: store.now() });
        return await shape(row);
    }

    return { enabled, WORKFLOW: ai.WORKFLOW, make, tick, latest, latestReviewed, latestUnreviewed, get, reviewed, gateFacts, pendingReviews, review, inputsFor };
}

module.exports = { createMarketBriefs };
