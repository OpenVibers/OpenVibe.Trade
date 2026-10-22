'use strict';
/**
 * Public surfaces are useful without JavaScript and carry the persistent disclaimer; the JSON twin
 * describes the same data as the HTML; feeds, sitemaps, robots and llms.txt behave; machine
 * endpoints answer; the historical marketplace branch is recorded as an open question, not built.
 */
const assert = require('assert');

function assertSitemapLastmods(xml, tag = 'url') {
    const entries = [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))];
    for (const [, body] of entries) {
        const match = /<lastmod>(\d{4}-\d{2}-\d{2})<\/lastmod>/.exec(body);
        assert.ok(match, body);
        assert.strictEqual(new Date(match[1]).toISOString().slice(0, 10), match[1]);
    }
    return entries;
}

const fs = require('fs');
const path = require('path');
const { boot, check, done } = require('./helpers/boot');

const DISCLAIMER = 'Information only — not investment advice; no trading here.';
const WORDS = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

(async () => {
    const t = await boot();
    const acme = await t.instrument({ symbol: 'ACME', name: 'Acme Corp', cik: '1234567', exchange: 'NYSE' });
    const { observation } = await t.observe(acme, { metric: 'price.close', value: '10.50', source_ref: 'a', observed_at: t.iso(t.T0 - 60e3), retrieved_at: t.iso(t.T0) });
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
        assertSitemapLastmods((await t.get('/sitemaps/instruments.xml')).text);
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
        const rel = await t.get('/release.json');
        assert.strictEqual(rel.status, 200);
        assert.deepStrictEqual(require('openvibe-contracts').validate('registry.release-manifest@1', rel.json()).errors, []);
        assert.strictEqual(rel.json().metrics_url, '/release-metrics');
        const report = await t.get('/release-metrics', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ counts: { applied: { style: 1 } } }) });
        assert.strictEqual(report.status, 204);
        assert.ok((await t.get('/metrics')).text.includes('release_client_updates_total{outcome="applied",reason="style"} 1\n'));
        const terms = await t.get('/terms');
        assert.strictEqual(terms.status, 200);
        assert.ok(terms.text.includes('OpenVibe.Trade'));
    });

    await check('the historical marketplace branch is an open question in docs, and nothing of it is implemented', async () => {
        const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'marketplace-open-question.md'), 'utf8');
        assert.ok(/ADR-025/.test(doc) && /unresolved|open question/i.test(doc));
        const tables = (await t.ctx.store.db.prepare("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema()").all()).map((r) => r.name);
        assert.ok(!tables.some((n) => /order|listing|escrow|wallet|custody|payment|cart/.test(n)), tables.join(','));
    });

    await check('llms-full.txt lists only indexable instruments with a short summary; the home carries the AI summary', async () => {
        const before = await t.get('/llms-full.txt');
        assert.strictEqual(before.status, 200);
        assert.ok(/text\/plain/.test(before.headers.get('content-type')));
        assert.ok(before.text.startsWith('# OpenVibe.Trade'));
        assert.ok(before.text.includes('not investment advice'));
        assert.ok(!before.text.includes('https://openvibe.trade/i/ACME'), 'nothing indexable is listed yet');
        assert.ok(Buffer.byteLength(before.text) <= 512 * 1024, 'llms-full.txt stays within maxBytes');

        // A person-reviewed context makes the page indexable; then it — and only it — is listed.
        await t.instrument({ symbol: 'OTHR', name: 'Other Co' });
        const pub = await t.get('/editor/i/ACME/context', { as: t.editor, form: { _csrf: t.csrf(t.editor), body: `Acme's price is stated by the source. ${WORDS(70)}`, cite: `observation:${observation.id}`, publish: '1' } });
        assert.ok(/n=context_published/.test(pub.headers.get('location')), 'the context published');
        const map = (await t.get('/sitemaps/instruments.xml')).text;
        assert.strictEqual(assertSitemapLastmods(map).length, 1);
        const instrument = await t.ctx.store.db.prepare("SELECT id, updated_at, context_published_at FROM trade_instruments WHERE symbol = 'ACME'").get();
        const observationTime = await t.ctx.store.db.prepare('SELECT MAX(recorded_at) AS at FROM trade_market_observations WHERE instrument_id = ?').get(instrument.id);
        const documentTime = await t.ctx.store.db.prepare('SELECT MAX(updated_at) AS at FROM trade_source_documents WHERE instrument_id = ?').get(instrument.id);
        const expected = new Date(Math.max(instrument.updated_at, instrument.context_published_at || 0, observationTime.at || 0, documentTime.at || 0)).toISOString().slice(0, 10);
        assert.ok(map.includes(`<loc>https://openvibe.trade/i/ACME</loc><lastmod>${expected}</lastmod>`));
        assertSitemapLastmods((await t.get('/sitemap.xml')).text, 'sitemap');
        const after = await t.get('/llms-full.txt');
        assert.ok(after.text.includes('https://openvibe.trade/i/ACME'));
        assert.ok(after.text.includes('### ACME — Acme Corp'));
        assert.ok(after.text.includes('word0'), 'the entry carries the context summary as text');
        assert.ok(!after.text.includes('https://openvibe.trade/i/OTHR'), 'an instrument without reviewed context is not listed');
        assert.ok(Buffer.byteLength(after.text) <= 512 * 1024);

        const home = (await t.get('/')).text;
        assert.ok(home.includes('<meta name="ai-summary"'), 'the home carries the ai-summary meta');
        // The list shows each instrument's latest number with its metric and time; the exchange column stays while one
        // is recorded (ACME's NYSE); an instrument with nothing observed shows its newest filing, or that it is on the SEC's list.
        assert.match(home, /<th scope="col">Exchange<\/th><th scope="col">Latest<\/th>/);
        assert.ok(!home.includes('no observation yet'));
        assert.match(home, /filed \d{4}-\d{2}-\d{2}|on the SEC's company list/);
        assert.match(home, /<td class="num"><data value="10\.50">10\.50<\/data> [^<]*<span class="muted">price\.close, /);
        assert.ok(home.includes('"@type":"WebPage"'), 'the home carries WebPage JSON-LD');
    });

    await check('the front page: one h1, a search, the numbers, its sections and questions (FAQPage JSON-LD); lists moved to /instruments and /filings', async () => {
        const r = await t.get('/');
        const body = r.text.slice(r.text.indexOf('<main'));
        assert.strictEqual((r.text.match(/<h1[\s>]/g) || []).length, 1, 'one h1');
        assert.ok(body.includes('action="/resolve"') && body.includes('class="tr-stats"') && body.includes('id="recent"') && body.includes('id="movers"') && body.includes('id="faq"'));
        assert.ok(body.includes('<a href="/filings?form=10-K">Annual report <span class="muted">(10-K)</span>'), 'filings by form, in plain words');
        assert.ok(body.includes('id="reports"') && body.indexOf('ACME', body.indexOf('id="reports"')) > 0, 'the 10-K among new annual and quarterly reports');
        assert.ok(!body.includes('id="rates"'), 'no rates section without a currency rate');
        const ld = [...r.text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
        const faq = ld.find((x) => x['@type'] === 'FAQPage');
        assert.ok(faq && ld.some((x) => x['@type'] === 'WebSite'));
        for (const q of faq.mainEntity) assert.ok(body.includes(`<summary>${q.name.replace(/'/g, '&#39;')}</summary>`), `the question is on the page: ${q.name}`);
        assert.doesNotMatch(body, /coming soon/i);
        const old = await t.get('/?page=2');
        assert.deepStrictEqual([old.status, old.headers.get('location')], [301, '/instruments?page=2']);
        const list = await t.get('/instruments');
        assert.ok(list.status === 200 && list.text.includes('<h1>Companies and currencies</h1>') && list.text.includes('Acme Corp'));
        const filings = await t.get('/filings');
        assert.ok(filings.status === 200 && filings.text.includes('ACME') && !/name="robots" content="noindex/.test(filings.text));
        const tenK = await t.get('/filings?form=10-K');
        assert.ok(tenK.text.includes('Annual reports (10-K)') && /name="robots" content="noindex/.test(tenK.text), 'one form: noindex, canonical /filings');
        assert.ok((await t.get('/sitemap.xml')).text.includes('https://openvibe.trade/sitemaps/pages.xml'));
        const pages = (await t.get('/sitemaps/pages.xml')).text;
        for (const p of ['/', '/instruments', '/filings', '/sources']) assert.ok(pages.includes(`<loc>https://openvibe.trade${p}</loc>`), p);
    });

    await check('the front page\'s euro rates: each currency\'s newest rate, its date and source, and the change from the same source', async () => {
        const usd = await t.instrument({ symbol: 'USD', name: 'US Dollar', kind: 'currency' });
        await t.observe(usd, { metric: 'rate', value: '1.1200', unit: 'USD', currency: 'USD', source_key: 'frankfurter-eur-rates', source_ref: 'usd-1', observed_at: t.iso(t.T0 - 2 * 86400e3), retrieved_at: t.iso(t.T0) });
        await t.observe(usd, { metric: 'rate', value: '1.1312', unit: 'USD', currency: 'USD', source_key: 'frankfurter-eur-rates', source_ref: 'usd-2', observed_at: t.iso(t.T0 - 86400e3), retrieved_at: t.iso(t.T0) });
        const body = (await t.get('/')).text;
        const at = body.indexOf('id="rates"');
        assert.ok(at > 0 && body.indexOf('<data value="1.1312">1.1312</data>', at) > at, 'the newest rate');
        assert.ok(body.includes('+1.00%'), 'the change from the previous rate of the same source');
        assert.ok(body.includes('Frankfurter (ECB data)'));
    });

    await t.close();
    done();
})();
