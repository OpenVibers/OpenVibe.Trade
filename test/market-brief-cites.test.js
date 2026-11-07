'use strict';
/**
 * A market brief's sources and citations are separated (11-07): its "Sources:" links were placed side by side with
 * nothing between them, so the page read "10-Q filings8-K filings424B2 filings…" and, being one unbreakable word,
 * pushed a 390 px phone 27 px sideways.
 *   node test/market-brief-cites.test.js
 */
const assert = require('assert');
const { marketBriefPage } = require('../server/render/home');

const out = String(marketBriefPage({
    date: '2026-11-07', reviewed: false, summary: 'A quiet day.', disclaimer: 'AI-written.', model: null, gaps: [],
    points: [{ text: 'Two filings moved.', cites: [{ url: '#obs_1', label: 'A' }, { url: '#obs_2', label: 'B' }] }],
    cites: [{ url: '/filings?form=10-Q', label: '10-Q filings' }, { url: '/filings?form=8-K', label: '8-K filings' }, { url: '/i/TPTS', label: 'TPTS' }],
}));

assert.ok(!/<\/a><a /.test(out), 'no two links touch');
assert.match(out, /Sources: <a href="\/filings\?form=10-Q">10-Q filings<\/a>, <a href="\/filings\?form=8-K">8-K filings<\/a>, <a href="\/i\/TPTS">TPTS<\/a>/);
assert.match(out, /<a class="cite" href="#obs_1">A<\/a> · <a class="cite" href="#obs_2">B<\/a>/);
console.log('market brief cites: sources and citations are separated');
