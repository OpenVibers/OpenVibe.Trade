'use strict';

/**
 * Read models shared by the pages, the JSON twins and the API, so the HTML and the
 * machine-readable representation always describe the same data (§32.5: no divergence).
 */
const seo = require('openvibe-publishing/seo');
const { iso } = require('./util');
const { DISCLAIMER } = require('./alerts');

function createReading({ store, ctx }) {
    function instrumentDto(i) {
        return {
            id: i.id, symbol: i.symbol, name: i.name, kind: i.kind, exchange: i.exchange, cik: i.cik, currency: i.currency,
            status: i.status, url: ctx.urls.instrument(i), created_at: iso(i.created_at), updated_at: iso(i.updated_at),
        };
    }

    /** Everything the instrument page shows. docsPage: { limit, offset }. */
    function instrument(i, { limit = 25, offset = 0 } = {}) {
        const now = store.now();
        const observations = ctx.observations.latest(i).map((o) => ctx.observations.dto(o, { now }));
        const docs = ctx.documents.forInstrument(i, { limit, offset }).map((d) => {
            const dto = ctx.documents.dto(d);
            const f = ctx.freshness.view(d.source_key, now);
            dto.freshness = { stale: f.stale, stale_since: f.stale_since, reason: !f.known ? 'source_unknown' : f.stale ? 'source_stale' : null };
            return dto;
        });
        const keys = [...new Set([...observations.map((o) => o.source.key), ...docs.map((d) => d.source.key)])];
        const sources = keys.sort().map((k) => ctx.freshness.view(k, now));
        const decision = ctx.indexing.decide(i, now);
        return {
            instrument: instrumentDto(i),
            aliases: ctx.instruments.aliases(i).map((a) => ({ kind: a.kind, value: a.value, normalized: a.normalized })),
            observations,
            documents: docs,
            documents_total: ctx.documents.count(i),
            sources,
            context: ctx.context.published(i),
            indexability: { indexable: decision.indexable, robots: decision.robots, reasons: decision.reasons },
            disclaimer: DISCLAIMER,
            generated_at: iso(now),
            decision,
        };
    }

    /** JSON-LD from real fields only: the page, what it is about, breadcrumbs. */
    function jsonLd(i) {
        const url = ctx.urls.instrument(i);
        const about = i.kind === 'equity'
            ? { '@type': 'Corporation', name: i.name, tickerSymbol: i.symbol }
            : { '@type': 'Thing', name: i.name };
        return [
            seo.compact({
                '@context': 'https://schema.org', '@type': 'WebPage', '@id': `${url}#page`, url, name: `${i.symbol} — ${i.name}`,
                about, dateModified: i.context_published_at ? iso(i.context_published_at) : undefined, inLanguage: 'en',
            }),
            seo.structuredData.breadcrumbs([{ name: 'Instruments', url: ctx.urls.abs('/') }, { name: i.symbol, url }]),
        ];
    }

    return { instrumentDto, instrument, jsonLd };
}

module.exports = { createReading };
