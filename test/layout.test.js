'use strict';
/**
 * The page shell (server/render/layout.js) is openvibe-publishing/layout's document (openvibe-shared/shell
 * page()): one title, the canonical and robots from the gate's decision, the JSON-LD, feed links, the Trade
 * stylesheet, the boost marker, the Frame (navbar mount, noscript navigation, footer and its init) and the
 * disclaimers Trade shows on every page.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { renderPage } = require('../server/render/layout');

const count = (html, re) => (html.match(re) || []).length;

(async () => {
    const t = await boot();

    await check('a page needs the gate decision: there is no default that makes it indexable', async () => {
        assert.throws(() => renderPage({ title: 'x', body: '', config: { baseUrl: 'https://openvibe.trade' } }), TypeError);
    });

    await check('the document head and frame come from openvibe-publishing/layout', async () => {
        await t.instrument({ symbol: 'ACME', name: 'Acme Corp' });
        for (const path of ['/', '/sources', '/i/ACME']) {
            const r = await t.get(path);
            assert.strictEqual(r.status, 200, `${path} → ${r.status}`);
            const html = r.text;
            const head = html.slice(0, html.indexOf('</head>'));
            const body = html.slice(html.indexOf('</head>'));
            assert.strictEqual(count(html, /<title>/g), 1, `${path}: exactly one <title>`);
            assert.ok(/<title>[^<]*OpenVibe\.Trade[^<]*<\/title>/.test(head), `${path}: the composed title`);
            assert.strictEqual(count(head, /<link rel="canonical" href="https:\/\/[^"]+">/g), 1, `${path}: one canonical`);
            assert.strictEqual(count(head, /<meta name="robots" content="(index|noindex), (follow|nofollow)">/g), 1, `${path}: one robots meta from the decision`);
            assert.ok(/<link rel="stylesheet" href="\/css\/trade\.css\?v=[0-9a-f]+">/.test(head), `${path}: the Trade stylesheet`);
            assert.ok(/<meta name="ov-boost" content="trade@[^"]+">/.test(head), `${path}: boost marker`);
            assert.ok(head.includes('<script src="/shared/web-runtime.js'), `${path}: the shared web runtime`);
            assert.ok(body.includes('<div id="navbar-mount"></div>'), `${path}: the navbar mount`);
            assert.ok(body.includes('<nav aria-label="Site"'), `${path}: the noscript navigation`);
            assert.ok(body.includes('id="ov-footer"'), `${path}: the server-rendered footer`);
            assert.ok(body.includes('OpenVibeFooter.init(window.__OV_PAGE.footer)'), `${path}: the footer is initialised`);
            assert.ok(body.includes('class="disclaimer"') && body.includes('disclaimer-foot'), `${path}: both disclaimers`);
        }
        const home = (await t.get('/')).text;
        const hhead = home.slice(0, home.indexOf('</head>'));
        assert.ok(hhead.includes('<link rel="alternate" type="application/rss+xml" href="/feed.xml"'), 'RSS feed link');
        assert.ok(hhead.includes('<link rel="alternate" type="application/atom+xml" href="/atom.xml"'), 'Atom feed link');
        assert.ok(hhead.includes('<link rel="alternate" type="application/feed+json" href="/feed.json"'), 'JSON feed link');
        assert.ok(home.includes('Recently shipped on OpenVibe.Trade'), 'the shipped line stays on the home page');
        const page = (await t.get('/i/ACME')).text;
        assert.ok(count(page.slice(0, page.indexOf('</head>')), /<script type="application\/ld\+json">/g) >= 1, 'JSON-LD on the instrument page');
    });

    await t.close();
    done();
})();
