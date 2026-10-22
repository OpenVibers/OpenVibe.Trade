'use strict';

/**
 * The front page (/): what OpenVibe.Trade is, a company search and the site's numbers, then the latest AI briefs, the
 * euro reference rates, the newest annual and quarterly reports, this week's filings by form, the newest filings,
 * companies with new numbers, what is here and the questions people ask. Every section is built from rows the page
 * passes; one with nothing to show renders nothing.
 *
 * The honesty rules of views.js hold: a number appears only with when it was observed and its source; a stale one
 * says so; AI text is labelled; nothing here is advice.
 */
const { html, raw } = require('openvibe-publishing/ssr');
const showcase = require('openvibe-shared/showcase');
const { when, staleBadge, grouped, clip, formLabel, filingLine, instrumentsTable } = require('./views');

const count = (n) => Number(n).toLocaleString('en-US');

function section({ id, title, lede, more, body, note }) {
    if (!body) return '';
    return html`<section class="tr-sec" aria-labelledby="${id}">
<div class="tr-head"><h2 id="${id}">${title}</h2>${more ? html`<a class="tr-more" href="${more.href}">${more.label}<span aria-hidden="true"> →</span></a>` : ''}</div>
${lede ? html`<p class="tr-lede">${lede}</p>` : ''}
${raw(String(body))}
${note ? html`<p class="muted">${note}</p>` : ''}
</section>`;
}

/** The numbers beside the hero, each a link; zero counts are left out. */
function stats(items) {
    const shown = items.filter((x) => x.n > 0);
    if (!shown.length) return '';
    return html`<ul class="tr-stats" aria-label="OpenVibe.Trade in numbers">${shown.map((x) => html`<li><a href="${x.href}"><b>${count(x.n)}</b><span>${x.label}</span></a></li>`)}</ul>`;
}

/** The newest AI briefs as cards. */
function briefCards(briefs, urls) {
    if (!briefs.length) return '';
    return html`<ul class="tr-cards">${briefs.map((b) => html`<li class="tr-card">
<p class="tr-card-top"><a href="${urls.path.instrument({ symbol: b.symbol })}#ai-brief"><strong>${b.symbol}</strong></a> <span class="muted">${b.name}</span></p>
<p>${clip(b.summary, 200)}</p>
<p class="muted tr-small">AI brief, ${when(b.created_at)}${b.as_of ? html` · figures to ${when(b.as_of)}` : ''}</p>
</li>`)}</ul>`;
}

/** "+0.04%" between two stated rates of the same source (null when either is missing or zero). */
function change(latest, previous) {
    if (!latest || !previous) return null;
    const a = Number(previous.value);
    const b = Number(latest.value);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return null;
    const pct = ((b - a) / a) * 100;
    return { pct, text: `${pct > 0 ? '+' : pct < 0 ? '−' : '±'}${Math.abs(pct).toFixed(2)}%` };
}

const SOURCE_NAME = { 'ecb-euro-reference-rates': 'European Central Bank', 'frankfurter-eur-rates': 'Frankfurter (ECB data)' };

// The currencies most people look for first; the rest of the euro reference rates fold away under them.
const MAJOR = ['USD', 'GBP', 'JPY', 'CHF', 'CNY', 'CAD', 'AUD', 'INR', 'KRW', 'MXN', 'BRL', 'SEK'];

/** The euro reference rates as cards: what one euro bought in each currency, the change, when, and from which source. */
function ratesTable(rates, urls) {
    if (!rates.length) return '';
    const rank = (r) => (MAJOR.includes(r.symbol) ? MAJOR.indexOf(r.symbol) : MAJOR.length);
    const sorted = [...rates].sort((a, b) => rank(a) - rank(b) || a.symbol.localeCompare(b.symbol));
    const major = sorted.filter((r) => MAJOR.includes(r.symbol));
    const rest = sorted.filter((r) => !MAJOR.includes(r.symbol));
    const grid = (list) => html`<ul class="tr-rates">${list.map((r) => rateCard(r, urls))}</ul>`;
    if (!major.length || !rest.length) return grid(sorted);
    return html`${grid(major)}<details class="tr-more-rates"><summary>All ${rates.length} currencies</summary>${grid(rest)}</details>`;
}

/** One currency: its rate per euro, the change from the same source's previous rate, the rate date and the source. */
function rateCard(r, urls) {
    const c = change(r.latest, r.previous);
    const day = (v) => html`<time datetime="${new Date(v).toISOString()}">${new Date(v).toISOString().slice(0, 10)}</time>`;
    return html`<li class="tr-rate">
<p class="tr-rate-top"><a href="${urls.path.instrument({ symbol: r.symbol })}"><strong>${r.symbol}</strong></a> <span class="muted">${r.name}</span></p>
<p class="tr-rate-value"><data value="${r.latest.value}">${grouped(r.latest.value)}</data> <span class="muted">per euro</span></p>
<p class="tr-small">${c ? html`<span class="${c.pct > 0 ? 'tr-up' : c.pct < 0 ? 'tr-down' : ''}">${c.text}</span> <span class="muted">since ${day(r.previous.observed_at)}</span>` : html`<span class="muted">no earlier rate</span>`}</p>
<p class="muted tr-small">Rate of ${day(r.latest.observed_at)} · ${SOURCE_NAME[r.latest.source_key] || r.latest.source_key}${r.dto && r.dto.freshness && r.dto.freshness.stale ? html` ${staleBadge(r.dto.freshness)}` : ''}</p>
</li>`;
}

/** The newest annual and quarterly reports as cards. */
function reportCards(list, urls) {
    if (!list.length) return '';
    return html`<ul class="tr-cards">${list.map((r) => html`<li class="tr-card">
<p class="tr-card-top"><a href="${urls.path.instrument(r.instrument)}#${r.document.id}"><strong>${r.instrument.symbol}</strong></a> <span class="badge">${r.document.form_type}</span></p>
<p>${r.instrument.name}</p>
<p class="muted tr-small">${formLabel(r.document.form_type) || 'Filing'}, ${r.document.published_at ? html`published ${when(r.document.published_at)}` : html`retrieved ${when(r.document.retrieved_at)}`}</p>
</li>`)}</ul>`;
}

/** This week's filings by form: chips with the plain name, the code and the count, each to /filings?form=. */
function formChips(counts) {
    if (!counts.length) return '';
    return html`<ul class="tr-chips">${counts.slice(0, 16).map((c) => html`<li><a href="/filings?form=${encodeURIComponent(c.form_type)}">${formLabel(c.form_type) ? html`${formLabel(c.form_type)} <span class="muted">(${c.form_type})</span>` : c.form_type}<span class="tr-n"><span class="sr-only">: </span>${count(c.count)}</span></a></li>`)}</ul>`;
}

/** Questions people ask, answered from how the site works (also the page's FAQPage JSON-LD). */
function faqItems() {
    return [
        { q: 'Is this investment advice?', a: 'No. OpenVibe.Trade shows public information with its sources: SEC filings, the numbers in them and euro reference rates. There is no order entry, no brokerage, no custody of money and no personal recommendation here.' },
        { q: 'Where does the data come from?', a: 'Filings come from the SEC\'s EDGAR feed and company list, read by OpenVibe.Sources. Company figures such as revenue, net income and cash come from the SEC\'s XBRL company facts, exactly as each company filed them. Currency rates come from the European Central Bank\'s reference rates, directly and through Frankfurter.' },
        { q: 'How fresh is it?', a: 'Every value shows when it was observed and when it was retrieved. The SEC\'s filing feed is read every 15 minutes and the rates every day. When a source falls behind, its values are marked stale with the time they went stale, and nothing is filled in by guessing.' },
        { q: 'What is an AI brief?', a: 'A short summary OpenVibe.AI writes from the numbers and filings on a company\'s page. Every point links to the figure it rests on. Briefs are labelled as AI-written, are not reviewed by a person and are not advice.' },
        { q: 'Can I get alerts?', a: 'Yes. Sign in with your free OpenVibe account to keep watchlists and set alert rules for a new filing, a kind of form, or a number crossing a line. Alerts arrive as OpenVibe notifications.' },
        { q: 'How do I find a company?', a: 'Search by ticker, SEC CIK number or company name. One match takes you straight to its page; when several match, they are listed and none is guessed.' },
    ];
}

function faqJsonLd(items) {
    return { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: items.map((x) => ({ '@type': 'Question', name: x.q, acceptedAnswer: { '@type': 'Answer', text: x.a } })) };
}

/**
 * d: { stats: { companies, currencies, filings, filingsDay, filers, figures, figureCompanies, briefs },
 *      briefs, rates: [{ symbol, name, latest, previous, dto }], reports, recent: [{ document, instrument }],
 *      forms: [{ form_type, count }], movers: { instruments, latest, latestDocs }, sync, faq }
 */
function homePage(d, urls) {
    const s = d.stats;
    const hero = html`<section class="sc-hero sc-split tr-hero"><div class="sc-hero-main">
<p class="sc-eyebrow">OpenVibe.Trade</p>
<h1>Market information that shows<span class="sc-accent"> its source</span></h1>
<p class="sc-hero-lede">US-listed companies from the SEC's own list, their filings as they arrive, the key numbers in those filings, euro reference rates and short AI briefs that cite every figure. Every value says when it was observed and which source stated it.</p>
<form class="search tr-search" id="find" method="get" action="/resolve" role="search"><label class="sr-only" for="q">Find a company by ticker, CIK or name</label><input id="q" name="q" type="search" maxlength="200" required placeholder="Ticker, CIK or company name, like AAPL"><button type="submit">Find</button></form>
<div class="sc-actions"><a class="sc-btn sc-primary" href="/filings">Latest filings</a><a class="sc-btn" href="#briefs">AI briefs</a><a class="sc-btn" href="/watchlists">Watchlists and alerts</a></div>
</div>
<div class="sc-hero-aside">${stats([
        { n: s.companies, label: 'companies on the SEC\'s list', href: '/instruments' },
        { n: s.filingsDay, label: 'filings in the last 24 hours', href: '/filings' },
        { n: s.filings, label: 'filings recorded', href: '/filings' },
        { n: s.figureCompanies, label: 'companies with figures from their filings', href: '/instruments' },
        { n: s.briefs, label: 'AI briefs written', href: '#briefs' },
        { n: s.currencies, label: 'currencies with euro rates', href: '#rates' },
    ])}</div></section>`;

    return html`${hero}
<p class="muted">What this site is not: there is no order entry, no brokerage, no custody of money or assets, no marketplace and no personal recommendation here.</p>
${section({ id: 'briefs', title: 'Latest AI briefs', lede: 'Short summaries of a company\'s latest numbers and filings, each point linked to the figure it rests on.', body: briefCards(d.briefs, urls), note: 'Written by OpenVibe.AI from SEC filings and the numbers in them, not reviewed by a person. Informational only; not investment advice.' })}
${section({ id: 'rates', title: 'Euro reference rates', lede: 'What one euro was worth in each currency on the latest rate date, as each source stated it. A change compares the two newest rates of the same source.', body: ratesTable(d.rates, urls) })}
${section({ id: 'reports', title: 'New annual and quarterly reports', lede: 'The latest 10-K and 10-Q filings, with the period figures read from them on each company\'s page.', more: { href: '/filings?form=10-Q', label: 'All quarterly reports' }, body: reportCards(d.reports, urls) })}
${section({ id: 'forms', title: 'Filed in the last 7 days', lede: 'Filings by form type, the most first.', more: { href: '/filings', label: 'Every filing' }, body: formChips(d.forms) })}
${section({ id: 'recent', title: 'Newest filings', lede: 'As they arrive from the SEC, each with when it was published and when it was retrieved.', more: { href: '/filings', label: 'More filings' }, body: d.recent.length ? html`<ul class="docs">${d.recent.map((r) => filingLine(r, urls))}</ul>` : '' })}
${section({ id: 'movers', title: 'Companies with something new', lede: 'The newest filing or figure first.', more: { href: '/instruments', label: `All ${count(s.instruments)} companies and currencies` }, body: d.movers.instruments.length ? instrumentsTable({ instruments: d.movers.instruments, latest: d.movers.latest, latestDocs: d.movers.latestDocs, urls }) : '' })}
${raw(showcase.features({
        title: 'What is here',
        items: [
            { icon: 'ov:search', title: 'Find a company', text: 'By ticker, SEC CIK or company name. One match takes you straight there; several are listed, never guessed between.', href: '/instruments' },
            { icon: 'ov:history', title: 'The numbers from the filings', text: 'Revenue, net income, EPS, cash flow and the balance sheet, exactly as each company filed them with the SEC, each with its period and filing.' },
            { icon: 'ov:ai', title: 'AI briefs that cite', text: 'OpenVibe.AI reads only the numbers and filings on the page and writes a short brief; every point links to the figure it rests on. Labelled, never advice.', href: '#briefs' },
            { icon: 'ov:docs', title: 'Filings as they arrive', text: 'SEC filings with their publication and retrieval dates, by form, with feeds in RSS, Atom and JSON.', href: '/filings' },
            { icon: 'ov:bell', title: 'Watchlists and alert rules', text: 'Private to you when signed in: an alert for a new filing or a number crossing a line.', href: '/watchlists' },
            { icon: 'ov:check', title: 'Source freshness', text: 'Every source with when it last answered; a source that falls behind marks its values stale.', href: '/sources' },
        ],
    }))}
<section class="tr-sec" aria-labelledby="faq"><div class="tr-head"><h2 id="faq">Questions and answers</h2></div>
<div class="tr-faq">${d.faq.map((x) => html`<details><summary>${x.q}</summary><p>${x.a}</p></details>`)}</div></section>
<p>Feeds of recent documents: <a href="/feed.xml">RSS</a> · <a href="/atom.xml">Atom</a> · <a href="/feed.json">JSON Feed</a>. Source freshness: <a href="/sources">sources</a>.${d.sync && d.sync.last_ok_at ? html` Last synchronised with OpenVibe.Sources ${when(d.sync.last_ok_at)}.` : ''}</p>`;
}

module.exports = { homePage, faqItems, faqJsonLd, change };
