'use strict';

/**
 * Indexability and OpenVibe.Search for instrument pages (openvibe-publishing/seo gate and
 * index-hooks). The only public, indexable objects Trade has are instrument pages; watchlists,
 * alert rules and deliveries are private and never reach this module.
 *
 * Gate facts for an instrument page:
 *   state        active → published, archived → unpublished
 *   sensitive    always (financial information): unreviewed_sensitive until a person-reviewed
 *                context is published (human-written, or an AI draft a person approved)
 *   authorship   the published context's record (an unreviewed AI draft is never published anyway)
 *   text         the published context (policy minWords, TRADE_GATE_MIN_WORDS)
 *   price        the newest monetary observation's observed_at: older than TRADE_PRICE_MAX_AGE_SEC
 *                → stale_price (noindex), so a crawler never indexes an old number as current
 *
 * Search gets a document only while the page is listable; otherwise a tombstone (and nothing at all
 * for a page that was never indexed). The sequencer raises the document revision only when the
 * document changes, so replays and worker ticks send nothing new.
 */
const seo = require('openvibe-publishing/seo');
const hooks = require('openvibe-publishing/index-hooks');
const authorship = require('openvibe-publishing/authorship');
const ssr = require('openvibe-publishing/ssr');

const OWNER = 'trade';

function createIndexing({ store, config, ctx }) {
    const { db } = store;
    const latestMonetary = db.prepare(`SELECT observed_at FROM trade_market_observations WHERE instrument_id = ? AND currency IS NOT NULL
                                       ORDER BY observed_at DESC LIMIT 1`);

    function publishedContext(instrument) {
        if (!instrument.context_published_revision) return null;
        return store.revisions.get(instrument.id, instrument.context_published_revision);
    }

    function decide(instrument, now = store.now()) {
        const rev = publishedContext(instrument);
        const rec = rev ? rev.meta.authorship : null;
        const review = rev ? store.reviews.latest(instrument.id, rev.number) : null;
        const reviewedContext = Boolean(rec && authorship.canPublish(rec, review).ok);
        const facts = {
            state: instrument.status === 'active' ? 'published' : 'unpublished',
            visibility: 'public',
            canonicalUrl: ctx.urls.instrument(instrument),
            text: rev ? ssr.markdownToText(rev.content) : '',
            sensitive: true,
            sensitiveReviewed: reviewedContext,
        };
        if (rec) Object.assign(facts, authorship.gateFacts(rec, review));
        const m = latestMonetary.get(instrument.id);
        if (m) facts.price = { observedAt: m.observed_at };
        return seo.evaluate(facts, { policy: { minWords: config.gate.minWords, priceMaxAgeMs: config.freshness.priceMaxAgeMs }, now });
    }

    function document(instrument, decision) {
        const rev = publishedContext(instrument);
        const identity = { owner: OWNER, type: 'instrument', id: instrument.id, revision: 0 };
        if (!decision.listable || instrument.status !== 'active') return hooks.tombstone(identity);
        const rec = rev ? rev.meta.authorship : null;
        const aliases = ctx.instruments.aliases(instrument).map((a) => a.value);
        return hooks.buildIndexDocument({
            ...identity,
            state: 'published',
            visibility: 'public',
            canonicalUrl: ctx.urls.instrument(instrument),
            title: `${instrument.symbol} — ${instrument.name}`,
            summary: rev ? ssr.markdownToText(rev.content, 300) : null,
            body: [rev ? ssr.markdownToText(rev.content) : '', `Also known as: ${aliases.join(', ')}`].join('\n\n'),
            facets: { kind: instrument.kind, symbol: instrument.symbol, ...(instrument.exchange ? { exchange: instrument.exchange } : {}) },
            authorship: rec,
            provenance: (rev && rev.fields.cites || []).slice(0, 40).map((c) => ({ service: OWNER, type: c.kind, id: c.id })),
            decision,
            publishedAt: instrument.context_published_at,
            updatedAt: rev ? rev.createdAt : null,
            language: 'en',
        });
    }

    /** Stamp and enqueue the Search document when it changed. Inside the caller's transaction. */
    function refresh(instrument, { traceparent } = {}) {
        if (!instrument) return null;
        const decision = decide(instrument);
        const doc = document(instrument, decision);
        const prev = store.sequencer.current(OWNER, 'instrument', instrument.id);
        if (doc.deleted && prev == null) return null;
        const stamped = store.sequencer.stamp(doc);
        if (prev != null && stamped.revision === prev) return null;
        return ctx.outbox.emit(hooks.indexEvent({ document: stamped, now: store.now() }), { traceparent });
    }

    return {
        OWNER,
        decide,
        refresh,
        refreshAll: () => store.tx(() => ctx.instruments.active().map((i) => refresh(i)).filter(Boolean)),
    };
}

module.exports = { createIndexing, OWNER };
