'use strict';

/** Canonical paths and absolute URLs (from BASE_URL). One form per page. */
const seo = require('openvibe-publishing/seo');

function createUrls(config) {
    const abs = (p) => seo.canonicalUrl(config.baseUrl, p);
    const path = {
        home: () => '/',
        instrument: (i) => `/i/${encodeURIComponent(i.symbol)}`,
        instrumentJson: (i) => `/i/${encodeURIComponent(i.symbol)}.json`,
        documentsFeed: (i, type) => `/i/${encodeURIComponent(i.symbol)}/documents.${type === 'atom' ? 'atom' : type === 'json' ? 'json' : 'xml'}`,
        sources: () => '/sources',
        watchlists: () => '/watchlists',
    };
    return {
        abs,
        path,
        instrument: (i) => abs(path.instrument(i)),
        documentAnchor: (i, d) => `${abs(path.instrument(i))}#${d.id}`,
    };
}

module.exports = { createUrls };
