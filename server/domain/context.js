'use strict';

/**
 * Context: the short, sourced explanation shown on an instrument page, as immutable revisions
 * (openvibe-publishing/revisions, prefix trade_context → trade_context_revisions) that cite
 * Trade's own documents and observations.
 *
 *   editor-written   a person on the editor list (TRADE_EDITORS or a Network admin) writes it;
 *                    authorship human; publishable at once
 *   AI draft         OpenVibe.AI's trade.summarize_market_context output, delivered by the AI
 *                    service (X-OV-Origin: ai). Authorship ai with the workflow run, never
 *                    attributed to a person, stored as a draft: it cannot be published — and the
 *                    page stays noindex — until a person records an approving review
 *                    (openvibe-publishing/authorship). Always labelled on the page and in JSON.
 *
 * Every revision records what it cites ({ kind: document|observation, id }) and as_of: the newest
 * observation or document time among the citations (never the time of writing). Text that reads as
 * personalised advice or a recommendation to trade is refused (ADR-025): Trade is information only.
 */
const authorship = require('openvibe-publishing/authorship');
const ssr = require('openvibe-publishing/ssr');
const { ApiError } = require('../http/errors');
const { iso, invalid } = require('./util');

const WORKFLOW = 'trade.summarize_market_context';
const ADVICE_RE = /\b(you should (buy|sell|hold|invest|short)|we recommend|i recommend|recommend(s|ed)? (buying|selling|holding)|strong (buy|sell)|(buy|sell|hold|outperform|underperform) rating|price target|guaranteed (return|profit)s?)\b/i;
const MAX_BODY = 20000;

function createContext({ store, config, ctx }) {
    const { db } = store;
    const editors = new Set(config.editors || []);
    const setPublished = db.prepare('UPDATE trade_instruments SET context_published_revision = ?, context_published_at = ?, updated_at = ? WHERE id = ?');

    function refuseAdvice(text) {
        if (ADVICE_RE.test(text)) {
            throw new ApiError(422, 'context.advice_refused', 'Trade publishes information only: context cannot recommend buying, selling or holding, or give price targets (ADR-025)');
        }
    }

    /** Validate cited refs: they must be this instrument's documents (not removed) or observations. */
    function resolveCites(instrument, cites) {
        if (cites == null) return [];
        if (!Array.isArray(cites) || cites.length > 50) throw invalid('cites must be a list of at most 50 { kind, id }');
        const seen = new Set();
        const out = [];
        for (const c of cites) {
            const kind = c && c.kind;
            const id = c && String(c.id || '');
            if (kind === 'document') {
                const d = ctx.documents.get(id);
                if (!d || d.instrument_id !== instrument.id || d.removed_at) throw invalid(`document ${id} is not a current document of ${instrument.symbol}`, 'context.bad_citation');
            } else if (kind === 'observation') {
                const o = ctx.observations.get(id);
                if (!o || o.instrument_id !== instrument.id) throw invalid(`observation ${id} is not an observation of ${instrument.symbol}`, 'context.bad_citation');
            } else {
                throw invalid('each citation is { kind: "document" | "observation", id }', 'context.bad_citation');
            }
            const key = `${kind}:${id}`;
            if (!seen.has(key)) { seen.add(key); out.push({ kind, id }); }
        }
        return out;
    }

    function asOf(cites) {
        let t = null;
        for (const c of cites) {
            let v = null;
            if (c.kind === 'observation') { const o = ctx.observations.get(c.id); v = o && o.observed_at; }
            else { const d = ctx.documents.get(c.id); v = d && (d.published_at || d.retrieved_at); }
            if (v != null && (t == null || v > t)) t = v;
        }
        return iso(t);
    }

    function isEditorSubject(viewer) {
        if (viewer.kind === 'user') return Boolean(viewer.editor && viewer.subject);
        if (viewer.kind === 'service') return Boolean(viewer.origin !== 'ai' && viewer.subject && editors.has(viewer.subject));
        return false;
    }

    function create(instrument, { content, fields, rec, author, message, expectedRevision }) {
        const head = store.revisions.headNumber(instrument.id);
        const expected = expectedRevision == null ? head : Number(expectedRevision);
        if (!Number.isInteger(expected) || expected < 0) throw invalid('expected_revision must be a revision number');
        return store.revisions.create({ entityId: instrument.id, expectedRevision: expected, content, fields, meta: { authorship: rec }, author, message, allowUnchanged: true }).revision;
    }

    /** AI output → markdown. Citations are indices into input_sources (what the AI was given). */
    function fromAiOutput(instrument, body) {
        const wf = body.workflow || {};
        if (wf.id !== WORKFLOW) throw invalid(`AI context must come from the ${WORKFLOW} workflow`, 'context.wrong_workflow');
        const runId = wf.run_id || wf.runId;
        if (!runId || typeof runId !== 'string') throw invalid('workflow.run_id is required', 'authorship.workflow_required');
        const out = body.output;
        if (!out || typeof out !== 'object' || typeof out.summary !== 'string' || !out.summary.trim()) throw invalid('output.summary is required');
        const sources = Array.isArray(body.input_sources) ? body.input_sources : [];
        const refs = sources.map((s) => {
            const t = s && s.source_type;
            const kind = t === 'trade.document' ? 'document' : t === 'trade.observation' ? 'observation' : null;
            if (!kind) throw invalid('input_sources entries are { source_type: trade.document | trade.observation, source_id }', 'context.bad_citation');
            return { kind, id: String(s.source_id || '') };
        });
        const refOf = (i) => {
            if (!Number.isInteger(i) || i < 0 || i >= refs.length) throw invalid(`citation ${i} is not one of the ${refs.length} input sources`, 'context.bad_citation');
            return refs[i];
        };
        const all = [];
        const cite = (list) => (Array.isArray(list) ? list.map((i) => { const r = refOf(i); all.push(r); return `[${i + 1}]`; }).join('') : '');
        const lines = [String(out.summary).trim().slice(0, 3000)];
        cite(out.citations);
        const obs = Array.isArray(out.observations) ? out.observations.slice(0, 30) : [];
        if (obs.length) {
            lines.push('', '**What the sources state**', '');
            for (const o of obs) {
                const when = typeof o.observed_at === 'string' && o.observed_at ? ` (as of ${o.observed_at.slice(0, 40)})` : ' (the source states no time)';
                lines.push(`- ${String(o.text || '').slice(0, 600)}${when} ${cite(o.citations)}`.trimEnd());
            }
        }
        const gaps = Array.isArray(out.gaps) ? out.gaps.slice(0, 20).map((g) => String(g).slice(0, 300)) : [];
        if (gaps.length) {
            lines.push('', '**Not covered by the sources**', '');
            for (const g of gaps) lines.push(`- ${g}`);
        }
        if (refs.length) {
            lines.push('', '**Sources given to the model**', '');
            refs.forEach((r, i) => lines.push(`${i + 1}. ${r.kind} ${r.id}`));
        }
        const rec = authorship.record({
            mode: 'ai',
            workflow: { id: WORKFLOW, runId, ...(wf.version != null ? { version: wf.version } : {}), ...(wf.model ? { model: String(wf.model) } : {}) },
            stubProvider: body.stub_provider === true,
            source: { label: `${instrument.symbol} documents and observations on OpenVibe.Trade` },
        });
        resolveCites(instrument, refs);   // every source the model was given must exist
        return { content: lines.join('\n'), cites: resolveCites(instrument, all), rec, gaps };
    }

    const api = {
        WORKFLOW,
        isEditorSubject,

        head: (instrument) => store.revisions.head(instrument.id),
        revision: (instrument, n) => store.revisions.get(instrument.id, n),
        revisions: (instrument, opts) => store.revisions.list(instrument.id, opts),

        /**
         * A new context revision. Editors: { body, cites?, expected_revision?, publish? }.
         * OpenVibe.AI (service, X-OV-Origin: ai): { workflow: { id, run_id, version?, model? },
         * input_sources: [{ source_type, source_id }], output: { summary, observations, gaps, citations },
         * stub_provider? } — always a draft.
         */
        propose(viewer, instrument, body = {}) {
            if (!instrument || instrument.status !== 'active') throw new ApiError(404, 'instrument.not_found', 'No such active instrument');
            if (viewer.kind === 'service' && viewer.origin === 'ai') {
                const { content, cites, rec, gaps } = fromAiOutput(instrument, body);
                refuseAdvice(content);
                const fields = { as_of: asOf(cites), cites, origin: 'ai', gaps };
                const revision = store.tx(() => create(instrument, { content, fields, rec, author: viewer.service, message: 'AI draft (needs a person\'s review)' }));
                return { revision, published: false };
            }
            if (!isEditorSubject(viewer)) throw new ApiError(403, 'context.forbidden', 'Only Trade editors write context');
            const text = typeof body.body === 'string' ? body.body.replace(/\r\n/g, '\n').trim() : '';
            if (!text) throw invalid('body is required');
            if (text.length > MAX_BODY) throw invalid(`body is longer than ${MAX_BODY} characters`);
            refuseAdvice(text);
            const cites = resolveCites(instrument, body.cites);
            const rec = authorship.record({ mode: 'human', authors: [viewer.subject] });
            const fields = { as_of: asOf(cites), cites, origin: 'editor' };
            return store.tx(() => {
                const revision = create(instrument, { content: text, fields, rec, author: viewer.subject, message: body.message ? String(body.message).slice(0, 300) : null, expectedRevision: body.expected_revision });
                if (body.publish === true || body.publish === 'on' || body.publish === '1') {
                    api.publish(instrument, revision.number);
                    return { revision, published: true };
                }
                return { revision, published: false };
            });
        },

        /** A person's review. Approving an AI draft publishes it. */
        review(viewer, instrument, number, { decision, note } = {}) {
            if (viewer.kind !== 'user' || !viewer.editor || !viewer.subject) throw new ApiError(403, 'review.forbidden', 'Only a person on the editor list can review context');
            const rev = store.revisions.get(instrument.id, Number(number));
            if (!rev) throw new ApiError(404, 'revision.not_found', 'No such context revision');
            return store.tx(() => {
                const review = store.reviews.record({ entityId: instrument.id, revision: rev.number, reviewer: viewer.subject, decision, note });
                let published = false;
                if (decision === 'approved') { api.publish(instrument, rev.number); published = true; }
                return { review, published };
            });
        },

        publish(instrument, number) {
            const rev = store.revisions.get(instrument.id, Number(number));
            if (!rev) throw new ApiError(404, 'revision.not_found', 'No such context revision');
            const rec = rev.meta.authorship;
            const ok = authorship.canPublish(rec, store.reviews.latest(instrument.id, rev.number));
            if (!ok.ok) throw new ApiError(409, 'context.review_required', 'AI-generated context needs an approving review by a person before it is published');
            return store.tx(() => {
                setPublished.run(rev.number, store.now(), store.now(), instrument.id);
                ctx.indexing.refresh(ctx.instruments.get(instrument.id));
                return rev;
            });
        },

        retract(viewer, instrument) {
            if (!isEditorSubject(viewer)) throw new ApiError(403, 'context.forbidden', 'Only Trade editors retract context');
            return store.tx(() => {
                setPublished.run(null, null, store.now(), instrument.id);
                ctx.indexing.refresh(ctx.instruments.get(instrument.id));
                return true;
            });
        },

        /** The published revision's view, or null. */
        published(instrument) {
            if (!instrument.context_published_revision) return null;
            const rev = store.revisions.get(instrument.id, instrument.context_published_revision);
            return rev ? api.view(instrument, rev) : null;
        },

        /** Revisions after the published one (drafts awaiting review or publication). */
        pending(instrument) {
            const published = instrument.context_published_revision || 0;
            return store.revisions.list(instrument.id, { limit: 20 }).filter((r) => r.number > published).map((r) => api.view(instrument, r));
        },

        view(instrument, rev) {
            const rec = rev.meta.authorship || null;
            const review = store.reviews.latest(instrument.id, rev.number);
            const cites = (rev.fields.cites || []).map((c) => {
                if (c.kind === 'observation') {
                    const o = ctx.observations.get(c.id);
                    return o ? { kind: c.kind, id: c.id, observation: ctx.observations.dto(o) } : { kind: c.kind, id: c.id, missing: true };
                }
                const d = ctx.documents.get(c.id);
                return d && !d.removed_at ? { kind: c.kind, id: c.id, document: ctx.documents.dto(d) } : { kind: c.kind, id: c.id, missing: true };
            });
            return {
                revision: rev.number,
                published: instrument.context_published_revision === rev.number,
                published_at: instrument.context_published_revision === rev.number ? iso(instrument.context_published_at) : null,
                written_at: rev.createdAt,
                as_of: rev.fields.as_of || null,
                origin: rev.fields.origin || null,
                body_markdown: rev.content,
                body_html: ssr.renderMarkdown(rev.content),
                text: ssr.markdownToText(rev.content),
                cites,
                authorship: rec,
                disclosure: rec ? authorship.disclosure(rec, review) : null,
                review: review ? { decision: review.decision, reviewed_at: review.reviewedAt, reviewer: review.reviewer } : null,
                needs_review: rec ? !authorship.canPublish(rec, review).ok : false,
            };
        },

        /** The input OpenVibe.AI's trade.summarize_market_context expects, numbered sources included. */
        input(instrument) {
            const sources = [];
            for (const o of ctx.observations.latest(instrument)) {
                const dto = ctx.observations.dto(o);
                sources.push({
                    source_type: 'trade.observation', source_id: o.id, url: o.source_url || undefined,
                    title: `${o.metric} of ${instrument.symbol}`,
                    observed_at: dto.observed_at, retrieved_at: dto.retrieved_at,
                    snippet: `${o.metric} = ${o.value} ${o.unit}${o.currency && o.currency !== o.unit ? ` (${o.currency})` : ''}${o.period ? `, period ${o.period}` : ''}`,
                    provenance: { source_key: o.source_key, stale: dto.freshness.stale, stale_since: dto.freshness.stale_since },
                });
            }
            for (const d of ctx.documents.forInstrument(instrument, { limit: 20 })) {
                const fresh = ctx.freshness.view(d.source_key);
                sources.push({
                    source_type: 'trade.document', source_id: d.id, url: d.url || undefined, title: d.title || undefined,
                    published_at: iso(d.published_at) || undefined, retrieved_at: iso(d.retrieved_at),
                    snippet: [d.form_type, d.filer_name, d.accession].filter(Boolean).join(' · ') || undefined,
                    provenance: { source_key: d.source_key, stale: fresh.stale, stale_since: fresh.stale_since },
                });
            }
            const clean = sources.map((s) => JSON.parse(JSON.stringify(s)));
            const windows = [...new Set(clean.map((s) => ctx.freshness.view(s.provenance.source_key).stale_after_sec))];
            const hours = Math.max(1, Math.ceil((windows.length ? Math.min(...windows) : config.freshness.defaultStaleAfterSec) / 3600));
            return {
                workflow: WORKFLOW,
                input: { instrument: { symbol: instrument.symbol, name: instrument.name, ...(instrument.exchange ? { exchange: instrument.exchange } : {}) }, stale_after_hours: hours, sources: clean },
                deliver_to: { method: 'POST', path: `/api/v1/instruments/${encodeURIComponent(instrument.symbol)}/context`, headers: { 'X-OV-Origin': 'ai' } },
            };
        },
    };
    return api;
}

module.exports = { createContext, WORKFLOW, ADVICE_RE };
