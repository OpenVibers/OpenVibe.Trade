'use strict';
// The home's "Latest" column: a figure with no period names when it was observed as a real <time>, not as escaped
// markup (the browser check of 2026-10-17 found "&lt;time datetime=…&gt;" text widening the table past the page).
const assert = require('assert');
const views = require('../server/render/views');

const urls = { path: { instrument: (i) => `/i/${i.symbol}` } };
const page = { instruments: [{ id: 1, symbol: 'AUD', name: 'Australian Dollar', kind: 'currency', exchange: null }] };
const latest = new Map([[1, { value: 1.6172, unit: 'AUD', metric: 'rate', period: null, observed_at: '2026-10-17T00:00:00.000Z' }]]);
const out = String(views.home({ page, recent: [], urls, sync: null, pager: null, latest }));
const cell = out.slice(out.indexOf('<td class="num">'), out.indexOf('</td>', out.indexOf('<td class="num">')));
assert.ok(cell.includes('<time datetime="2026-10-17T00:00:00.000Z">2026-10-17 00:00 UTC</time>'), cell);
assert.ok(!out.includes('&lt;time'), 'no escaped markup');
console.log('home latest cell: all checks passed');
