'use strict';
/**
 * Public surfaces are useful without JavaScript and carry the persistent disclaimer; the JSON twin
 * describes the same data as the HTML; feeds, sitemaps, robots and llms.txt behave; machine
 * endpoints answer; the historical marketplace branch is recorded as an open question, not built.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, check, done } = require('./helpers/boot');

const DISCLAIMER = 'Information only — not investment advice; no trading here.';

(async () => {
    const t = await boot();
    const acme = t.instrument({ symbol: 'ACME', name: 'Acme Corp', cik: '1234567', exchange: 'NYSE' });
    t.observe(acme, { metric: 'price.close', value: '10.50', source_ref: 'a', observed_at: t.iso(t.T0 - 60e3), retrieved_at: t.iso(t.T0) });
    t.sources.setSource('sec-xbrl-filings', { lastSuccessAt: t.iso(t.T0), staleAfterSec: 2700 });
    t.sources.putItem({ canonical_url: 'https://www.sec.gov/Archives/edgar/data/1234567/000123456726000001/0001234567-26-000001-index.htm', title: 'ACME CORP', summary: '10-K', published_at: '2026-09-22T10:00:00Z', retrieved_at: t.iso(t.T0) });
    t.sources.putItem({ canonical_url: 'https://www.sec.gov/Archives/edgar/data/1234567/000123456726000002/0001234567-26-000002-index.htm', title: 'ACME CORP', summary: '8-K', retrieved_at: t.iso(t.T0) });
    await t.ctx.sync.run();

    await check('every public page carries the persistent, plain disclaimer (header and footer)', async () => {
        for (const p of ['/', '/i/ACME', '/sources', '/watchlists', '/resolve?q=nothing', '/does-not-exist']) {
            const r = await t.get(p);
            assert.ok(r.text.split(DISCLAIMER).length - 1 >= 2, `${p}: disclaimer missing`);
        }
        assert.strictEqual((await t.get('/i/ACME.json')).json().disclaimer, DISCLAIMER);
        assert.ok((await t.get('/feed.xml')).text.includes('not investment advice'));
        assert.ok((await t.get('/llms.txt')).text.includes('not investment advice'));
    });

    await check('the instrument page is complete without JavaScript: observations, documents, freshness, context, feeds', async () => {
        const r = await t.get('/i/ACME');
        assert.strictEqual(r.status, 200);
        const html = r.text.replace(/<script[\s\S]*?<\/script>/g, '');
        for (const s of ['<h1>ACME', 'price.close', '10.50', '10-K', '8-K', 'accession 0001234567-26-000001', 'Source freshness', 'No reviewed context has been published', 'documents.xml', 'Sign in']) assert.ok(html.includes(s), s);
        assert.ok(html.includes('Filed <span class="muted">not stated by the source</span>'), 'a filing without a date says so');
        assert.ok(/<link rel="canonical" href="https:\/\/openvibe.trade\/i\/ACME">/.test(r.text));
        assert.ok(r.text.includes('<link rel="alternate" type="application/rss+xml"'));
    });

    await check('the JSON twin describes the same data as the HTML (no divergence)', async () => {
        const j = (await t.get('/i/ACME.json')).json();
        const h = (await t.get('/i/ACME')).text;
        for (const o of j.observations) assert.ok(h.includes(`<data value="${o.value}">`) && h.includes(`datetime="${o.observed_at}"`));
        for (const d of j.documents) assert.ok(h.includes(`id="${d.id}"`));
        assert.strictEqual(j.documents.length, 2);
        assert.deepStrictEqual(j.indexability.reasons.map((x) => x.code).includes('unreviewed_sensitive'), true);
    });

    await check('feeds: RSS, Atom and JSON Feed per instrument and site-wide; undated items get no invented date', async () => {
        const rss = await t.get('/i/ACME/documents.xml');
        assert.strictEqual(rss.status, 200);
        assert.ok(/application\/rss\+xml/.test(rss.headers.get('content-type')));
        assert.strictEqual((rss.text.match(/<item>/g) || []).length, 2);
        assert.strictEqual((rss.text.match(/<pubDate>/g) || []).length, 1, 'only the dated filing has a pubDate');
        assert.ok(rss.text.includes('https://openvibe.trade/i/ACME#doc_'), 'items link back to the canonical page');
        const atom = await t.get('/i/ACME/documents.atom');
        assert.strictEqual((atom.text.match(/<entry>/g) || []).length, 1, 'Atom leaves out the undated entry');
        const jf = (await t.get('/i/ACME/documents.json')).json();
        assert.strictEqual(jf.items.length, 2);
        assert.strictEqual(jf.items.filter((i) => i.date_published).length, 1);
        assert.strictEqual((await t.get('/i/NOPE/documents.xml')).status, 404);
        assert.strictEqual((await t.get('/feed.json')).json().items.length, 2);
    });

    await check('robots, llms.txt and the sitemap index; no page is indexable before reviewed context', async () => {
        const robots = (await t.get('/robots.txt')).text;
        assert.ok(robots.includes('Sitemap: https://openvibe.trade/sitemap.xml'));
        assert.ok(/automated-consumer policy/.test(robots));
        assert.ok((await t.get('/sitemap.xml')).text.includes('https://openvibe.trade/sitemaps/instruments.xml'));
        assert.ok(!(await t.get('/sitemaps/instruments.xml')).text.includes('<loc>'), 'no indexable instrument yet');
        assert.ok((await t.get('/llms.txt')).text.startsWith('# OpenVibe.Trade'));
    });

    await check('resolve: one match redirects to the canonical page; a miss says no guess was made', async () => {
        const r = await t.get('/resolve?q=1234567');
        assert.strictEqual(r.status, 302);
        assert.strictEqual(r.headers.get('location'), '/i/ACME');
        const miss = await t.get('/resolve?q=Acm');
        assert.strictEqual(miss.status, 404);
        assert.ok(miss.text.includes('no guess is made'));
    });

    await check('machine endpoints: health, readiness (truthful), release, legal pages', async () => {
        assert.strictEqual((await t.get('/api/health')).json().service, 'openvibe-trade');
        const ready = await t.get('/api/ready');
        assert.strictEqual(ready.status, 200);
        const body = JSON.stringify(ready.json());
        assert.ok(body.includes('relay off'), 'the events relay is reported off in tests');
        assert.strictEqual((await t.get('/release.json')).status, 200);
        const terms = await t.get('/terms');
        assert.strictEqual(terms.status, 200);
        assert.ok(terms.text.includes('OpenVibe.Trade'));
    });

    await check('the historical marketplace branch is an open question in docs, and nothing of it is implemented', async () => {
        const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'marketplace-open-question.md'), 'utf8');
        assert.ok(/ADR-025/.test(doc) && /unresolved|open question/i.test(doc));
        const tables = t.ctx.store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
        assert.ok(!tables.some((n) => /order|listing|escrow|wallet|custody|payment|cart/.test(n)), tables.join(','));
    });

    await t.close();
    done();
})();
