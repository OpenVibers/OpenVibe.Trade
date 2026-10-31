'use strict';

const { labelOf, metricOrder } = require('../domain/facts');

/** The stated decimal with thousands separators, digit for digit ("39544000000" → "39,544,000,000"). */
function grouped(value) {
    const m = /^(-?)(\d+)(\.\d+)?$/.exec(String(value));
    return m ? `${m[1]}${m[2].replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${m[3] || ''}` : String(value);
}
/**
 * Page bodies (HTML fragments for layout.renderPage). All escaping goes through
 * openvibe-publishing/ssr's `html` tagged template; `raw()` only wraps HTML built here or by the
 * package's safe Markdown renderer.
 *
 * The honesty rules are visible here:
 *   - a number appears only in an observation row, next to its observed_at, retrieved_at and source
 *   - no observation → the sentence "no number is shown", never a placeholder value
 *   - a stale source or value carries a "stale since …" badge; unknown freshness says so
 *   - AI context carries its disclosure; the disclaimer is in the layout on every page
 */
const { html, raw, breadcrumbsHtml, paginationHtml } = require('openvibe-publishing/ssr');
const showcase = require('openvibe-shared/showcase');
const kit = require('openvibe-shared/kit');

const ISO = (v) => (v == null ? null : (typeof v === 'number' ? new Date(v).toISOString() : String(v)));

/** A timestamp as `<time>` in UTC to the minute, or the given fallback text. */
function when(v, fallback = 'not stated by the source') {
    const s = ISO(v);
    if (!s) return html`<span class="muted">${fallback}</span>`;
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return html`<span class="muted">${fallback}</span>`;
    return html`<time datetime="${d.toISOString()}">${d.toISOString().slice(0, 16).replace('T', ' ')} UTC</time>`;
}

function staleBadge(f) {
    if (!f) return '';
    if (f.stale) {
        return html`<span class="badge stale">stale</span>${f.stale_since ? html` since ${when(f.stale_since)}` : html` <span class="muted">(${f.reason === 'source_unknown' ? 'freshness unknown' : 'never fetched successfully'})</span>`}`;
    }
    return html`<span class="badge fresh">current</span>`;
}

/** A metric that states a price (or a rate) rather than a filed period figure. */
const PRICE_METRIC_RE = /^(?:price|quote|close|rate)(?:\.|$)/i;
const isPriceMetric = (metric) => PRICE_METRIC_RE.test(String(metric || ''));

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dateOf = (v) => {
    const s = ISO(v);
    if (!s) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
};
/** A short time for a row: "22 Sep 10:00 UTC"; the full ISO stays in the <time datetime>. */
function shortWhen(v) {
    const d = v instanceof Date ? v : dateOf(v);
    if (!d) return 'time not stated';
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${hh}:${mm} UTC`;
}
/** A full time for the folded details: "22 Sep 2026 10:00 UTC". */
function fullWhen(v) {
    const d = v instanceof Date ? v : dateOf(v);
    if (!d) return 'time not stated';
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${hh}:${mm} UTC`;
}

/** A duration in seconds as words ("1 hour", "2 days"), for a max age the database holds. */
function durationWords(sec) {
    const n = Number(sec);
    if (!Number.isFinite(n) || n <= 0) return null;
    for (const [size, label] of [[86400, 'day'], [3600, 'hour'], [60, 'minute'], [1, 'second']]) {
        if (n % size === 0) { const v = n / size; return `${v} ${label}${v === 1 ? '' : 's'}`; }
    }
    return `${n} seconds`;
}

const STALE_REASON = {
    value_older_than_max_age: 'The value is older than its maximum age.',
    source_stale: 'The source is behind its own freshness window.',
    source_unknown: 'The source has not reported its freshness.',
};

/** The pill's title: the short reason, kept even when the pill only says "stale since …". */
function freshnessTitle(o) {
    const f = o.freshness || {};
    const age = durationWords(o.max_age_sec);
    if (!f.stale) return "Current: inside the source window and the value's maximum age.";
    if (f.reason === 'value_older_than_max_age' && age) return `The value is older than its ${age} maximum age.`;
    return STALE_REASON[f.reason] || 'The source is stale.';
}

/** The folded explanation of the verdict: the date it went stale, why, and the value's own max age. */
function freshnessExplanation(o) {
    const f = o.freshness || {};
    const age = durationWords(o.max_age_sec);
    if (!f.stale) {
        return age
            ? `Current: inside its ${age} maximum age and the source freshness window.`
            : 'Current: no maximum age is set for this value, so the source freshness window decides.';
    }
    const since = f.stale_since ? ` since ${fullWhen(f.stale_since)}` : '';
    if (f.reason === 'value_older_than_max_age' && age) return `Stale${since}: the value is older than its ${age} maximum age.`;
    if (f.reason === 'source_stale') return `Stale${since}: the source is behind its own freshness window.`;
    if (f.reason === 'source_unknown') return 'Stale: the source has not reported its freshness.';
    return `Stale${since}: the source is stale.`;
}

function csrfField(token) { return html`<input type="hidden" name="_csrf" value="${token}">`; }

function notice(n) {
    if (!n) return '';
    return html`<p class="notice ${n.error ? 'error' : ''}" role="status">${n.text}</p>`;
}

// ── Home ─────────────────────────────────────────────────────────────────────

/** Page 1 of the front page opens with what OpenVibe.Trade is for (openvibe-shared/showcase). */
function tradeShowcase() {
    return showcase.hero({
        eyebrow: 'OpenVibe.Trade',
        title: 'Market information that shows', accent: 'its source',
        lede: 'About 10,000 US-listed companies from the SEC\'s own list, their filings as they arrive, the key numbers in those filings, and short AI briefs that cite every figure they use. Every value shows when it was observed, when it was retrieved and which source stated it; when a source falls behind, its data is marked stale and never replaced with a guess.',
        actions: [{ label: 'Find a company', href: '#find', primary: true }, { label: 'Latest AI briefs', href: '#briefs' }, { label: 'Source freshness', href: '/sources' }],
    }) + showcase.features({
        title: 'What is here',
        items: [
            { icon: 'ov:search', title: 'Find an instrument', text: 'By ticker, SEC CIK or company name. One match takes you straight there; several are listed, never guessed between.' },
            { icon: 'ov:history', title: 'The numbers from the filings', text: 'Revenue, net income, EPS, cash flow and the balance sheet, exactly as each company filed them with the SEC, each with its period and filing.' },
            { icon: 'ov:ai', title: 'AI briefs that cite', text: 'OpenVibe.AI reads only the numbers and filings on the page and writes a short brief; every point links to the figure it rests on. Labelled, never advice.' },
            { icon: 'ov:docs', title: 'Filings as they arrive', text: 'SEC filings gathered by OpenVibe.Sources with their publication and retrieval dates, and feeds in RSS, Atom and JSON.' },
            { icon: 'ov:bell', title: 'Watchlists and alert rules', text: 'Private to you when signed in: an alert for a new filing or a number crossing a line.' },
        ],
    });
}

/** The newest AI briefs, one per company, for the home page. */
function recentBriefs(briefs, urls) {
    if (!briefs.length) return html`<p class="empty">No AI briefs yet. They are written when a company files a report, or when you ask for one on its page.</p>`;
    return html`<ul class="briefs">${briefs.map((b) => html`<li><a href="${urls.path.instrument({ symbol: b.symbol })}#ai-brief"><strong>${b.symbol}</strong></a> ${b.name}
  <p>${clip(b.summary, 220)}</p><span class="muted">AI brief, ${when(b.created_at)}${b.as_of ? html` · figures to ${when(b.as_of)}` : ''}</span></li>`)}</ul>
<p class="muted">Written by OpenVibe.AI from SEC filings and the numbers in them, not reviewed by a person. Informational only; not investment advice.</p>`;
}

function clip(text, n) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    if (s.length <= n) return s;
    const cut = s.slice(0, n);
    return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), n - 20))}…`;
}

/** The instruments table: each row's headline number (or newest filing), as on the old front page. */
function instrumentsTable({ instruments, latest = new Map(), latestDocs = new Map(), urls, caption = null }) {
    // The exchange column only when an instrument on the page has one (a currency has none to record).
    const exchanges = instruments.some((i) => i.exchange);
    // The headline number when there is one; else the newest filing (most companies on a given day only filed); else
    // nothing to show yet beyond the SEC's company list.
    const latestCell = (i, o, d) => (o
        ? html`<td class="num"><data value="${o.value}">${grouped(o.value)}</data> ${o.unit} <span class="muted">${labelOf(o.metric)}${o.period ? `, ${o.period}` : html`, ${when(o.observed_at)}`}</span>${o.freshness && o.freshness.stale ? html` ${staleBadge(o.freshness)}` : ''}</td>`
        : d ? html`<td><a href="${urls.path.instrument(i)}#${d.id}">${d.form_type ? html`<span class="badge">${d.form_type}</span> ` : ''}filed ${when(d.published_at || d.first_seen_at)}</a></td>`
            : html`<td><span class="muted">on the SEC's company list</span></td>`);
    const rows = instruments.map((i) => html`<tr>
        <td><a href="${urls.path.instrument(i)}"><strong>${i.symbol}</strong></a></td>
        <td>${i.name}</td><td>${i.kind}</td>${exchanges ? html`<td>${i.exchange || html`<span class="muted">not recorded</span>`}</td>` : ''}${latestCell(i, latest.get(i.id), latestDocs.get(i.id))}
    </tr>`);
    return html`<table tabindex="0" class="data">${caption ? html`<caption>${caption}</caption>` : ''}<thead><tr><th scope="col">Symbol</th><th scope="col">Name</th><th scope="col">Kind</th>${exchanges ? html`<th scope="col">Exchange</th>` : ''}<th scope="col">Latest</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** /instruments: every instrument, the newest filing or figure first (the old front page's list). */
function instrumentsPage({ page, urls, pager, latest, latestDocs }) {
    return html`${raw(breadcrumbsHtml([{ name: 'Trade', url: '/' }, { name: 'Companies and currencies' }]))}
<h1>Companies and currencies</h1>
<p class="lede">${page.total.toLocaleString('en-US')} instruments: US-listed companies from the SEC's own list and the currencies in the euro reference rates, the newest filing or figure first.</p>
<form class="search" method="get" action="/resolve" role="search">
  <label for="q">Find an instrument by ticker, CIK or company name</label>
  <input id="q" name="q" type="search" maxlength="200" required>
  <button type="submit">Find</button>
</form>
${page.instruments.length ? html`${instrumentsTable({ instruments: page.instruments, latest, latestDocs, urls })}${raw(paginationHtml(pager))}` : html`<p class="empty">No instruments have been added yet.</p>`}`;
}

/** One filing as a list line: company, form (with its plain name), title, published and retrieved. */
function filingLine(r, urls) {
    return html`<li><a href="${urls.path.instrument(r.instrument)}#${r.document.id}"><strong>${r.instrument.symbol}</strong></a>
        ${r.document.form_type ? html`<span class="badge" title="${formLabel(r.document.form_type) || ''}">${r.document.form_type}</span>` : ''} ${r.document.title || r.document.filer_name || 'Untitled document'}
        — ${r.document.published_at ? html`published ${when(r.document.published_at)}` : html`<span class="muted">no publication date stated</span>`}, retrieved ${when(r.document.retrieved_at)}</li>`;
}

/** /filings[?form=]: the newest SEC filings, optionally of one kind of form. */
function filingsPage({ docs, pager, form, counts, urls }) {
    return html`${raw(breadcrumbsHtml([{ name: 'Trade', url: '/' }, { name: 'Filings', url: form ? '/filings' : undefined }, ...(form ? [{ name: form }] : [])].map((c) => (c.url === undefined ? { name: c.name } : c))))}
<h1>${form ? `${formLabel(form) ? `${formLabel(form)}s` : 'Filings'} (${form})` : 'SEC filings as they arrive'}</h1>
<p class="lede">Filings from the SEC's EDGAR feed, gathered by OpenVibe.Sources, the newest first, each with when it was published and when it was retrieved. Information only; not investment advice.</p>
${counts.length ? html`<p class="muted">By form, the last 7 days:</p><ul class="tr-chips">${form ? html`<li><a href="/filings">All forms</a></li>` : ''}${counts.map((c) => html`<li>${c.form_type === form ? html`<span aria-current="page">${c.form_type}<span class="tr-n">${c.count.toLocaleString('en-US')}</span></span>` : html`<a href="/filings?form=${encodeURIComponent(c.form_type)}">${c.form_type}<span class="tr-n"><span class="sr-only">: </span>${c.count.toLocaleString('en-US')}</span></a>`}</li>`)}</ul>` : ''}
${docs.length ? html`<ul class="docs">${docs.map((r) => filingLine(r, urls))}</ul>${raw(paginationHtml(pager))}` : html`<p class="empty">No filings of this form have been recorded.</p>`}
<p>Feeds of recent documents: <a href="/feed.xml">RSS</a> · <a href="/atom.xml">Atom</a> · <a href="/feed.json">JSON Feed</a>.</p>`;
}

/** SEC form types in plain words (the SEC's own descriptions, shortened); unknown forms have none. */
const FORM_LABEL = {
    '10-K': 'Annual report', '10-K/A': 'Amended annual report', '10-Q': 'Quarterly report', '10-Q/A': 'Amended quarterly report',
    '8-K': 'Current report', '8-K/A': 'Amended current report', '6-K': 'Foreign issuer report', '20-F': 'Foreign annual report', '40-F': 'Canadian annual report',
    'DEF 14A': 'Proxy statement', 'PRE 14A': 'Preliminary proxy statement', 'DEFA14A': 'Additional proxy material',
    'S-1': 'Registration for a new offering', 'S-1/A': 'Amended registration', 'S-3': 'Shelf registration', 'S-3ASR': 'Automatic shelf registration', 'S-4': 'Merger registration', 'S-8': 'Employee stock plan registration',
    '424B2': 'Prospectus supplement', '424B3': 'Prospectus', '424B4': 'Final prospectus', '424B5': 'Prospectus supplement',
    'SC 13D': 'Beneficial ownership report', 'SC 13G': 'Passive ownership report', '11-K': 'Employee plan annual report', 'ARS': 'Annual report to shareholders',
    'N-CSR': 'Fund shareholder report', '10-D': 'Asset-backed distribution report', 'POS AM': 'Post-effective amendment',
};
const formLabel = (f) => FORM_LABEL[f] || null;

// ── Resolve ──────────────────────────────────────────────────────────────────

function resolvePage({ result, urls }) {
    const cands = result.candidates.map((i) => html`<li><a href="${urls.path.instrument(i)}">${i.symbol}</a> — ${i.name}</li>`);
    return html`
<h1>Find an instrument</h1>
<form class="search" method="get" action="/resolve" role="search">
  <label for="q">Ticker, CIK or company name</label>
  <input id="q" name="q" type="search" maxlength="200" value="${result.query}" required>
  <button type="submit">Find</button>
</form>
${result.status === 'ambiguous' ? html`<p>“${result.query}” matches several instruments by name. None was chosen for you:</p><ul>${cands}</ul>` : ''}
${result.status === 'not_found' ? html`<p class="empty">No instrument matches “${result.query}” as a CIK, a ticker or an exact company name. Resolution is exact on purpose: no guess is made.</p>` : ''}`;
}

// ── Instrument ───────────────────────────────────────────────────────────────

function observationsList(instrument, observations, sourceNames = new Map()) {
    if (!observations.length) {
        return html`<p class="empty" id="no-observations">No observations have been recorded for ${instrument.symbol}, so no number is shown.</p>`;
    }
    const ordered = observations.slice().sort((a, b) => (metricOrder(a.metric) < metricOrder(b.metric) ? -1 : metricOrder(a.metric) > metricOrder(b.metric) ? 1 : 0));
    const items = ordered.map((o) => {
        const sourceName = sourceNames.get(o.source.key) || o.source.key;
        const price = isPriceMetric(o.metric);
        const row = html`<li id="${o.id}" class="obs-item${o.freshness.stale ? ' is-stale' : ''}">
<div class="obs-name">${labelOf(o.metric)}${o.period ? html` <span class="obs-period">(${o.period})</span>` : ''}</div>
<div class="obs-value-row"><div class="obs-value"><data value="${o.value}">${grouped(o.value)}</data> <small>${o.unit}${o.currency && o.currency !== o.unit ? ` ${o.currency}` : ''}</small></div>
<span class="ovk-badge ovk-badge--${o.freshness.stale ? 'warn' : 'ok'}" title="${freshnessTitle(o)}">${o.freshness.stale ? `stale${o.freshness.stale_since ? html` since ${shortWhen(o.freshness.stale_since)}` : ''}` : 'current'}</span></div>
${price ? html`<div class="obs-note">Not a live quote</div>` : ''}
<p class="obs-line">Observed <time datetime="${ISO(o.observed_at)}">${shortWhen(o.observed_at)}</time> · ${o.source.url ? html`<a href="${o.source.url}" rel="nofollow noopener">${sourceName} ↗</a>` : html`${sourceName}`}</p>
<details class="obs-details"><summary>Source details</summary>
<dl class="obs-detail-grid">
<dt>Retrieved</dt><dd><time datetime="${ISO(o.retrieved_at)}">${fullWhen(o.retrieved_at)}</time></dd>
<dt>Source reference</dt><dd><code class="obs-ref">${o.source.ref}</code></dd>
<dt>Source URL</dt><dd>${o.source.url ? html`<a href="${o.source.url}" rel="nofollow noopener">${o.source.url}</a>` : html`<span class="muted">No source URL recorded.</span>`}</dd>
<dt>Freshness</dt><dd>${freshnessExplanation(o)}</dd>
${price ? html`<dt>Quote</dt><dd>Source-stated price, not a live quote. Trade holds no live market feed and records no source delay.</dd>` : ''}
</dl></details>
</li>`;
        return row;
    });
    return html`<ol class="obs-list">${items}</ol>`;
}

function sourcesTable(list, { caption }) {
    if (!list.length) return html`<p class="empty">No sources have reported yet.</p>`;
    const rows = list.map((s) => ({
        source: html`<span id="source-${s.key}">${s.name || s.key}${s.name && s.name !== s.key ? html` <span class="muted">${s.key}</span>` : ''}</span>`,
        freshness: s.status === 'fresh' ? html`<span class="badge fresh">current</span>` : s.status === 'unknown' ? html`<span class="badge stale">freshness unknown</span>` : html`<span class="badge stale">stale</span>${s.stale_since ? html` since ${when(s.stale_since)}` : ''}`,
        last: when(s.last_success_at, 'never'),
        window: s.stale_after_sec ? `${Math.round(s.stale_after_sec / 60)} min` : html`<span class="muted">not stated</span>`,
        upstream: s.upstream_status || html`<span class="muted">not reported</span>`,
    }));
    return html`${raw(kit.table({
        id: 'sources',
        columns: [
            { key: 'source', label: 'Source', primary: true, html: true },
            { key: 'freshness', label: 'Freshness', html: true },
            { key: 'last', label: 'Last successful fetch', html: true },
            { key: 'window', label: 'Stale after', html: true },
            { key: 'upstream', label: 'Sources reports', html: true },
        ],
        rows,
        caption,
    }))}`;
}

function citeList(cites, instrument, urls) {
    if (!cites.length) return html`<p class="muted">This context cites no documents or observations.</p>`;
    const items = cites.map((c) => {
        if (c.missing) return html`<li class="muted">${c.kind} ${c.id} is no longer available.</li>`;
        if (c.observation) {
            const o = c.observation;
            return html`<li><a href="${urls.path.instrument(instrument)}#${o.id}">${o.metric} = ${o.value} ${o.unit}</a>, observed ${when(o.observed_at)}, source ${o.source.key}, retrieved ${when(o.retrieved_at)} ${staleBadge(o.freshness)}</li>`;
        }
        const d = c.document;
        return html`<li><a href="${urls.path.instrument(instrument)}#${d.id}">${d.form_type ? `${d.form_type}: ` : ''}${d.title || d.filer_name || d.id}</a>, ${d.published_at ? html`published ${when(d.published_at)}` : 'no publication date stated'}, retrieved ${when(d.retrieved_at)}</li>`;
    });
    return html`<ol class="cites">${items}</ol>`;
}

function disclosureLine(ctx) {
    if (ctx.disclosure) {
        return html`<p class="disclosure"><strong>${ctx.disclosure.short}.</strong> ${ctx.disclosure.long}${ctx.review && ctx.review.decision === 'approved' ? html` Approved ${when(ctx.review.reviewed_at)}.` : ''}</p>`;
    }
    return html`<p class="disclosure">Written by a Trade editor.</p>`;
}

function contextSection(instrument, ctx, urls, { pending = [], editor = false } = {}) {
    const pend = editor && pending.length
        ? html`<p class="notice">${pending.length} context revision${pending.length === 1 ? '' : 's'} waiting — <a href="/editor/i/${encodeURIComponent(instrument.symbol)}">review in the editor</a>.</p>` : '';
    if (!ctx) {
        return html`<section class="context" aria-labelledby="context-h"><h2 id="context-h">Context</h2>
<p class="empty">No reviewed context has been published for ${instrument.symbol}. The observations and documents below are shown as their sources stated them.</p>${pend}</section>`;
    }
    return html`<section class="context" aria-labelledby="context-h"><h2 id="context-h">Context</h2>
${disclosureLine(ctx)}
<p class="meta">As of ${ctx.as_of ? when(ctx.as_of) : html`<span class="muted">no dated source cited</span>`} · written ${when(ctx.written_at)} · published ${when(ctx.published_at)} · revision ${ctx.revision}</p>
<div class="context-body">${raw(ctx.body_html)}</div>
<h3>Cited</h3>
${citeList(ctx.cites, instrument, urls)}
<p class="muted">Context describes what sources state. It is not a recommendation to buy, sell or hold anything.</p>
${pend}</section>`;
}

function documentsSection(instrument, docs, { pager, urls }) {
    const feeds = html`<p class="feeds">Feeds of ${instrument.symbol} documents: <a href="${urls.path.documentsFeed(instrument, 'rss')}">RSS</a> · <a href="${urls.path.documentsFeed(instrument, 'atom')}">Atom</a> · <a href="${urls.path.documentsFeed(instrument, 'json')}">JSON Feed</a></p>`;
    if (!docs.length) return html`<section aria-labelledby="docs-h"><h2 id="docs-h">Documents</h2><p class="empty">No documents from sources have been recorded for ${instrument.symbol}.</p>${feeds}</section>`;
    const items = docs.map((d) => html`<li id="${d.id}" class="doc">
        ${d.form_type ? html`<span class="badge">${d.form_type}</span> ` : ''}${d.url ? html`<a href="${d.url}" rel="nofollow noopener">${d.title || d.filer_name || 'Document'}</a>` : (d.title || 'Document')}
        <div class="meta">${d.kind === 'filing' ? 'Filed' : 'Published'} ${when(d.published_at)} · retrieved ${when(d.retrieved_at)} · source ${d.source.key}${d.freshness && d.freshness.stale ? html` (${staleBadge(d.freshness)}: newer documents may be missing)` : ''}${d.accession ? ` · accession ${d.accession}` : ''}</div>
    </li>`);
    return html`<section aria-labelledby="docs-h"><h2 id="docs-h">Documents</h2><ul class="docs">${items}</ul>
${raw(paginationHtml(pager))}${feeds}</section>`;
}

function personalTools(instrument, { viewer, watchlists, csrf, loginHref, limits }) {
    if (!viewer || viewer.kind !== 'user' || !viewer.subject) {
        return html`<section class="personal" aria-labelledby="personal-h"><h2 id="personal-h">Watch this instrument</h2>
<p><a href="${loginHref}">Sign in</a> to add ${instrument.symbol} to a private watchlist or to get an alert when a new document or observation arrives. Watchlists and alerts are free, always: no paid tier, no card, no trial.</p></section>`;
    }
    const first = watchlists[0];
    const oneWatch = kit.action({ action: '/watchlists/watch', hidden: { _csrf: csrf, symbol: instrument.symbol }, label: first ? 'Add to watchlist' : `Watch ${instrument.symbol}`, icon: 'star', kind: 'primary' });
    const oneAlert = kit.action({ action: '/alerts', hidden: { _csrf: csrf, symbol: instrument.symbol, kind: 'new_document' }, label: 'Alert me to new filings', icon: 'bell', kind: 'quiet' });
    const options = watchlists.map((w) => html`<option value="${w.id}">${w.name}</option>`);
    const choose = watchlists.length > 1 ? html`<form method="post" action="/watchlists/item" class="inline-form">${csrfField(csrf)}
  <input type="hidden" name="symbol" value="${instrument.symbol}">
  <label for="wl">Add to another watchlist</label><select id="wl" name="watchlist_id">${options}</select>
  <button type="submit">Add</button></form>` : '';
    const more = kit.fold({
        title: 'More watchlist and alert options',
        body: html`${choose}
<form method="post" action="/alerts" class="inline-form">${csrfField(csrf)}
  <input type="hidden" name="symbol" value="${instrument.symbol}"><input type="hidden" name="kind" value="filing_type">
  <label>Alert me to a kind of filing <input name="form_types" placeholder="10-K, 10-Q, 8-K" maxlength="120" required></label>
  <button type="submit">Create filing alert</button></form>
<form method="post" action="/alerts" class="inline-form">${csrfField(csrf)}
  <input type="hidden" name="symbol" value="${instrument.symbol}"><input type="hidden" name="kind" value="threshold">
  <label>Alert me when a number crosses a line</label>
  <label>Observation <input name="metric" placeholder="metric, e.g. price.close" maxlength="80" required></label>
  <label>Operator <select name="operator"><option value="above">above</option><option value="below">below</option></select>
  <input name="threshold" placeholder="value" maxlength="40" required> <input name="unit" placeholder="unit, e.g. USD" maxlength="20" required></label>
  <button type="submit">Create observation alert</button></form>
${limits ? html`<p class="muted">An account can keep up to ${limits.watchlistsPerSubject} watchlists of ${limits.itemsPerWatchlist} instruments, and up to ${limits.alertRulesPerSubject} alert rules. These limits are this site's configuration, not a paid tier.</p>` : ''}`,
    });
    return html`<section class="personal" aria-labelledby="personal-h"><h2 id="personal-h">Watch this instrument <span class="badge">private</span></h2>
<p class="muted">One tap: keep ${instrument.symbol} on your watchlist, or get a notification for every new filing.${first ? html` The watchlist button adds it to “${first.name}”.` : html` The first tap starts a private watchlist called “Watching”.`}</p>
<p class="personal-actions">${raw(oneWatch)} ${raw(oneAlert)}</p>
${raw(more)}
<p class="muted">Alerts are delivered as OpenVibe notifications, once per triggering observation or document. No email is sent.</p>
</section>`;
}

/** The AI brief: labelled, its points linked to the rows they cite, and how to get one when there is none. */
function briefSection(instrument, d, { hasDocuments = false } = {}) {
    const b = d.brief;
    const anchor = (c) => `#${c.id}`;
    const ask = d.briefs && d.briefs.canAsk ? html`<form method="post" action="/i/${encodeURIComponent(instrument.symbol)}/brief" class="inline-form">
  <button type="submit">${b ? 'Check for a newer brief' : 'Write an AI brief'}</button></form>` : '';
    if (!b) {
        // Briefs are written when a company files, or when a reader asks: with nothing to write from, there is no section.
        if (!ask) return '';
        return html`<section aria-labelledby="ai-brief-h" id="ai-brief"><h2 id="ai-brief-h">AI brief</h2>
<p>OpenVibe.AI can write a short brief on ${instrument.symbol} from the SEC numbers and filings on this page, every point linked to the figure it rests on. It takes a few seconds.</p>${ask}</section>`;
    }
    return html`<section aria-labelledby="ai-brief-h" id="ai-brief" class="ai-brief"><h2 id="ai-brief-h">AI brief <span class="badge">OpenVibe.AI desk — AI-written, not reviewed by a person</span></h2>
${b.summary ? html`<p>${b.summary}</p>` : ''}
${b.points.length ? html`<ul>${b.points.map((p) => html`<li>${p.text} ${p.cites.map((c, n) => html`<a class="cite" href="${anchor(c)}" title="${c.kind === 'document' ? 'The filing this rests on' : 'The figure this rests on'}">[${n + 1}]</a>`)}</li>`)}</ul>` : ''}
<p class="muted">${b.disclaimer} Written ${when(b.created_at)}${b.as_of ? html` from figures and filings up to ${when(b.as_of)}` : ''}${b.model ? html` (${b.model})` : ''}.</p>
${b.gaps.length ? html`<details><summary>What the sources did not support</summary><ul>${b.gaps.map((g) => html`<li>${g}</li>`)}</ul></details>` : ''}
${hasDocuments ? html`<p class="muted">It rests on the <a href="#docs-h">filings on this page</a> and the figures above; each point links to the row it cites.</p>` : ''}
${ask}</section>`;
}

function instrumentPage(d) {
    const { instrument, aliases, observations, sources, documents, context, urls } = d;
    const crumbs = breadcrumbsHtml([{ name: 'Instruments', url: '/' }, { name: instrument.symbol }]);
    const meta = [instrument.kind, instrument.exchange ? `exchange ${instrument.exchange}` : null, instrument.cik ? `CIK ${instrument.cik}` : null, instrument.currency ? `trades in ${instrument.currency}` : null].filter(Boolean).join(' · ');
    const other = aliases.filter((a) => !(a.kind === 'ticker' && a.normalized === instrument.symbol) && !(a.kind === 'cik' && a.normalized === instrument.cik) && a.kind !== 'name');
    return html`${raw(crumbs)}
<h1>${instrument.symbol} <span class="name">${instrument.name}</span></h1>
<p class="meta">${meta}${other.length ? html` · also ${other.map((a) => a.value).join(', ')}` : ''}${instrument.status !== 'active' ? html` · <span class="badge stale">archived</span>` : ''}</p>
${notice(d.notice)}
${briefSection(instrument, d, { hasDocuments: documents.length > 0 })}
<section aria-labelledby="obs-h"><h2 id="obs-h" class="obs-h">Observations</h2>
<p class="obs-intro">Each value as the source stated it, with when it was true and where it came from.</p>
<p class="obs-free"><strong>Free, always.</strong> No paid tier, no card, no trial.</p>
${observationsList(instrument, observations, new Map(sources.map((s) => [s.key, s.name || s.key])))}
<details class="obs-how"><summary>How to read this</summary><ul>
<li>Observed is when the source says the value was true; retrieved is when Trade fetched it.</li>
<li>The source reference is the source's own identity for the datum; the source link and the full URL open it.</li>
<li>A value past its maximum age is marked stale, and so is a value whose source is behind its freshness window. A stale value stays on the page with its time; it is never replaced with a guess.</li>
<li>Trade has no live market feed. A price is the value the source stated at that time, not a live quote, and no source delay is recorded.</li>
<li>Information only; not investment advice. There is no trading here.</li>
</ul></details></section>
${personalTools(instrument, d)}
${contextSection(instrument, context, urls, { pending: d.pending, editor: d.viewer && d.viewer.editor })}
${documentsSection(instrument, documents, { pager: d.pager, urls })}
<section aria-labelledby="src-h"><h2 id="src-h">Source freshness</h2>${sourcesTable(sources, { caption: `Sources behind this page. A source is stale when its last successful fetch is older than its window.` })}</section>
<p class="muted">Machine-readable: <a href="${urls.path.instrumentJson(instrument)}">${instrument.symbol}.json</a> (the same data with every timestamp and source).</p>`;
}

// ── Sources ──────────────────────────────────────────────────────────────────

function sourcesPage({ sources, sync }) {
    return html`<h1>Source freshness</h1>
<p class="lede">Every source Trade shows data from, with its last successful fetch. A stale source's data stays on the pages with its timestamps and a “stale since” label; it is never replaced with an invented value.</p>
${sourcesTable(sources, { caption: 'Sources and their freshness, computed with this site’s clock.' })}
<p class="muted">Synchronisation with OpenVibe.Sources: ${!sync.enabled ? 'not configured' : sync.last_error ? html`failing since ${when(sync.last_error_at)} (${sync.last_error})` : sync.last_ok_at ? html`last succeeded ${when(sync.last_ok_at)}` : 'not run yet'}.</p>`;
}

// ── Watchlists (private) ─────────────────────────────────────────────────────

function watchlistsPage({ viewer, lists, rules, deliveries, csrf, loginHref, notice: n }) {
    if (!viewer || viewer.kind !== 'user' || !viewer.subject) {
        return html`<h1>Watchlists</h1><p>Watchlists and alerts are private to your OpenVibe account. <a href="${loginHref}">Sign in</a> to see yours.</p>`;
    }
    const listHtml = lists.map((w) => html`<section class="card" aria-label="${w.name}">
<h2>${w.name}</h2>
${w.items.length ? html`<table tabindex="0" class="data"><thead><tr><th scope="col">Symbol</th><th scope="col">Name</th><th scope="col">Note</th><th scope="col"></th></tr></thead><tbody>
${w.items.map((it) => html`<tr><td><a href="${new URL(it.instrument.url).pathname}">${it.instrument.symbol}</a></td><td>${it.instrument.name}</td><td>${it.note || ''}</td>
<td><form method="post" action="/watchlists/item/remove" class="inline">${csrfField(csrf)}<input type="hidden" name="watchlist_id" value="${w.id}"><input type="hidden" name="symbol" value="${it.instrument.symbol}"><button type="submit">Remove</button></form></td></tr>`)}
</tbody></table>` : html`<p class="empty">Empty. Add instruments from their pages or below.</p>`}
<form method="post" action="/watchlists/item" class="inline-form">${csrfField(csrf)}<input type="hidden" name="watchlist_id" value="${w.id}">
  <label>Add by ticker, CIK or name <input name="q" maxlength="200" required></label> <button type="submit">Add</button></form>
<form method="post" action="/watchlists/rename" class="inline-form">${csrfField(csrf)}<input type="hidden" name="watchlist_id" value="${w.id}">
  <label>Rename <input name="name" maxlength="80" value="${w.name}" required></label> <button type="submit">Rename</button></form>
<form method="post" action="/watchlists/delete" class="inline-form">${csrfField(csrf)}<input type="hidden" name="watchlist_id" value="${w.id}"><button type="submit" class="danger">Delete this watchlist</button></form>
</section>`);
    const ruleRows = rules.map((r) => html`<tr><td><a href="/i/${encodeURIComponent(r.instrument.symbol)}">${r.instrument.symbol}</a></td>
<td>${r.kind === 'threshold' ? `${r.metric} ${r.operator} ${r.threshold} ${r.unit}${r.currency ? ` (${r.currency})` : ''}` : r.kind === 'filing_type' ? `new filing: ${(r.form_types || []).join(', ')}` : 'any new document'}</td>
<td>${when(r.created_at)}</td>
<td><form method="post" action="/alerts/delete" class="inline">${csrfField(csrf)}<input type="hidden" name="rule_id" value="${r.id}"><button type="submit">Delete</button></form></td></tr>`);
    const delRows = deliveries.map((x) => html`<li>${when(x.created_at)} — ${x.trigger.kind === 'observation'
        ? html`${x.trigger.metric} = ${x.trigger.value} ${x.trigger.unit}, observed ${when(x.trigger.observed_at)} (${x.trigger.source_key})`
        : html`${x.trigger.form_type ? `${x.trigger.form_type}: ` : ''}${x.trigger.title || 'document'}, ${x.trigger.published_at ? html`published ${when(x.trigger.published_at)}` : 'no date stated'}`}</li>`);
    return html`<h1>Your watchlists <span class="badge">private</span></h1>
<p class="muted">Only you can see this page. It is never cached by shared caches, indexed or listed anywhere.</p>
${notice(n)}
${listHtml}
<form method="post" action="/watchlists" class="card">${csrfField(csrf)}
  <label for="wl-name">New watchlist</label><input id="wl-name" name="name" maxlength="80" required>
  <button type="submit">Create</button></form>
<h2>Your alerts</h2>
${rules.length ? html`<table tabindex="0" class="data"><thead><tr><th scope="col">Instrument</th><th scope="col">Condition</th><th scope="col">Created</th><th scope="col"></th></tr></thead><tbody>${ruleRows}</tbody></table>`
        : html`<p class="empty">No alerts. Create one from an instrument’s page.</p>`}
<h2>Recent alert deliveries</h2>
${deliveries.length ? html`<ul>${delRows}</ul>` : html`<p class="empty">None yet.</p>`}`;
}

// ── Editor ───────────────────────────────────────────────────────────────────

function editorHome({ instruments, pending, csrf, notice: n, kinds }) {
    return html`<h1>Editor</h1>${notice(n)}
<form method="post" action="/editor/instruments" class="card">${csrfField(csrf)}
  <h2>Add an instrument</h2>
  <label>Symbol <input name="symbol" maxlength="16" required></label>
  <label>Name <input name="name" maxlength="200" required></label>
  <label>Kind <select name="kind">${kinds.map((k) => html`<option>${k}</option>`)}</select></label>
  <label>Exchange (optional) <input name="exchange" maxlength="40"></label>
  <label>SEC CIK (optional) <input name="cik" maxlength="13"></label>
  <label>Trading currency (optional) <input name="currency" maxlength="3"></label>
  <button type="submit">Add instrument</button></form>
<h2>Context waiting for review</h2>
${pending.length ? html`<ul>${pending.map((p) => html`<li><a href="/editor/i/${encodeURIComponent(p.symbol)}">${p.symbol}</a>: revision ${p.revision} (${p.label})</li>`)}</ul>` : html`<p class="empty">Nothing is waiting.</p>`}
<h2>Instruments editors added</h2>
${instruments.length ? html`<ul>${instruments.map((i) => html`<li><a href="/editor/i/${encodeURIComponent(i.symbol)}">${i.symbol}</a> — ${i.name}</li>`)}</ul>` : html`<p class="empty">None yet.</p>`}
<p class="muted">Every other instrument (the companies on SEC's list, the currencies the rates name) opens at <code>/editor/i/SYMBOL</code>.</p>`;
}

async function editorInstrument({ instrument, aliases, revisions, documents, observations, csrf, notice: n, kinds, head }) {
    const revs = await revisions.map((r) => html`<li class="card">
<p><strong>Revision ${r.revision}</strong> ${r.published ? html`<span class="badge fresh">published</span>` : ''} ${r.disclosure ? html`<span class="badge">${r.disclosure.short}</span>` : html`<span class="badge">editor</span>`}
 ${r.needs_review ? html`<span class="badge stale">needs a person’s review</span>` : ''} · written ${when(r.written_at)} · as of ${r.as_of ? when(r.as_of) : 'no dated citation'}</p>
<div class="context-body">${raw(r.body_html)}</div>
${r.disclosure ? html`<p class="disclosure">${r.disclosure.long}</p>` : ''}
${!r.published && r.needs_review ? html`<form method="post" action="/editor/i/${encodeURIComponent(instrument.symbol)}/context/${r.revision}/review" class="inline-form">${csrfField(csrf)}
  <label>Note <input name="note" maxlength="500"></label>
  <button type="submit" name="decision" value="approved">Approve and publish</button> <button type="submit" name="decision" value="rejected" class="danger">Reject</button></form>` : ''}
${!r.published && !r.needs_review ? html`<form method="post" action="/editor/i/${encodeURIComponent(instrument.symbol)}/context/${r.revision}/publish" class="inline-form">${csrfField(csrf)}<button type="submit">Publish this revision</button></form>` : ''}
</li>`);
    const citeOptions = [
        ...observations.map((o) => html`<label><input type="checkbox" name="cite" value="observation:${o.id}"> ${o.metric} = ${o.value} ${o.unit}, observed ${when(o.observed_at)}</label>`),
        ...documents.map((d) => html`<label><input type="checkbox" name="cite" value="document:${d.id}"> ${d.form_type || d.kind}: ${d.title || d.filer_name || d.id}, ${d.published_at ? html`published ${when(d.published_at)}` : 'no date'}</label>`),
    ];
    return html`${raw(breadcrumbsHtml([{ name: 'Editor', url: '/editor' }, { name: instrument.symbol }]))}
<h1>${instrument.symbol} — ${instrument.name}</h1>${notice(n)}
<p><a href="/i/${encodeURIComponent(instrument.symbol)}">Public page</a></p>
<form method="post" action="/editor/i/${encodeURIComponent(instrument.symbol)}" class="card">${csrfField(csrf)}
  <h2>Details</h2>
  <label>Name <input name="name" maxlength="200" value="${instrument.name}" required></label>
  <label>Kind <select name="kind">${kinds.map((k) => html`<option ${k === instrument.kind ? 'selected' : ''}>${k}</option>`)}</select></label>
  <label>Exchange <input name="exchange" maxlength="40" value="${instrument.exchange || ''}"></label>
  <label>SEC CIK <input name="cik" maxlength="13" value="${instrument.cik || ''}"></label>
  <label>Trading currency <input name="currency" maxlength="3" value="${instrument.currency || ''}"></label>
  <label>Status <select name="status"><option ${instrument.status === 'active' ? 'selected' : ''}>active</option><option ${instrument.status === 'archived' ? 'selected' : ''}>archived</option></select></label>
  <button type="submit">Save</button></form>
<form method="post" action="/editor/i/${encodeURIComponent(instrument.symbol)}/aliases" class="card">${csrfField(csrf)}
  <h2>Aliases</h2>
  <ul>${aliases.map((a) => html`<li>${a.kind}: ${a.value} <span class="muted">(${a.normalized})</span></li>`)}</ul>
  <label>Kind <select name="kind"><option>ticker</option><option>cik</option><option>name</option></select></label>
  <label>Value <input name="value" maxlength="200" required></label>
  <button type="submit">Add alias</button></form>
<form method="post" action="/editor/i/${encodeURIComponent(instrument.symbol)}/context" class="card">${csrfField(csrf)}
  <h2>Write context</h2>
  <p class="muted">Describe what the cited sources state. No recommendations, targets or predictions: text that reads as advice is refused.</p>
  <input type="hidden" name="expected_revision" value="${head}">
  <label for="ctx-body">Context (Markdown)</label><textarea id="ctx-body" name="body" rows="10" maxlength="20000" required></textarea>
  <fieldset><legend>Cite</legend>${citeOptions.length ? citeOptions : html`<p class="muted">Nothing to cite yet.</p>`}</fieldset>
  <label><input type="checkbox" name="publish" value="1"> Publish now</label>
  <button type="submit">Save revision</button></form>
${instrument.context_published_revision ? html`<form method="post" action="/editor/i/${encodeURIComponent(instrument.symbol)}/context/retract" class="inline-form">${csrfField(csrf)}<button type="submit" class="danger">Retract the published context</button></form>` : ''}
<h2>Context revisions</h2>
${revisions.length ? html`<ol class="revisions">${revs}</ol>` : html`<p class="empty">No context yet.</p>`}`;
}

function errorPage({ status, title, message }) {
    return html`<h1>${title}</h1><p>${message}</p><p class="muted">Error ${status}. <a href="/">All instruments</a></p>`;
}

// Observation rows: compact by design (three fit a phone's first screen), with the long provenance folded.
const observationStyles = `
.obs-h { margin-top: 1.2rem; }
.obs-intro { margin: 0 0 2px; color: var(--text-secondary); font-size: .93rem; line-height: 1.35; }
.obs-free { margin: 0 0 6px; color: var(--text-muted); font-size: .82rem; line-height: 1.3; }
.obs-free strong { color: var(--text-primary); }
.obs-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.obs-item { padding: 7px 10px 5px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-card); min-width: 0; }
.obs-name { color: var(--text-primary); font-size: .93rem; font-weight: 650; line-height: 1.3; overflow-wrap: anywhere; }
.obs-period { color: var(--text-muted); font-weight: 400; }
.obs-value-row { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 1px 10px; margin-top: 1px; }
.obs-value { color: var(--text-primary); font-size: 1.4rem; font-weight: 800; line-height: 1.1; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.obs-value small { color: var(--text-secondary); font-size: .72rem; font-weight: 600; }
.obs-note { color: var(--text-muted); font-size: .67rem; font-weight: 700; letter-spacing: .03em; text-transform: uppercase; line-height: 1.2; }
.obs-line { margin: 2px 0 0; color: var(--text-muted); font-size: .8rem; line-height: 1.3; overflow-wrap: anywhere; }
.obs-line a { color: var(--accent); text-decoration: none; }
.obs-line a:hover, .obs-line a:focus-visible { text-decoration: underline; }
.obs-details { margin-top: 0; }
.obs-details > summary { display: inline-flex; align-items: center; gap: 4px; min-height: 26px; color: var(--text-secondary); font-size: .79rem; font-weight: 600; cursor: pointer; list-style: none; }
.obs-details > summary::-webkit-details-marker { display: none; }
.obs-details > summary::before { content: '▸'; color: var(--text-muted); }
.obs-details[open] > summary::before { content: '▾'; }
.obs-detail-grid { margin: 0 0 4px; display: grid; gap: 3px; color: var(--text-secondary); font-size: .79rem; line-height: 1.4; }
.obs-detail-grid dt { color: var(--text-muted); font-weight: 650; }
.obs-detail-grid dd { margin: 0; overflow-wrap: anywhere; }
.obs-detail-grid a { color: var(--accent); }
.obs-ref { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .76rem; overflow-wrap: anywhere; word-break: break-word; }
.obs-how { margin-top: 10px; border-top: 1px solid var(--border); padding-top: 2px; }
.obs-how > summary { display: flex; align-items: center; gap: 4px; min-height: 32px; color: var(--text-secondary); font-size: .84rem; font-weight: 650; cursor: pointer; list-style: none; }
.obs-how > summary::-webkit-details-marker { display: none; }
.obs-how > summary::before { content: '▸'; color: var(--text-muted); }
.obs-how[open] > summary::before { content: '▾'; }
.obs-how ul { margin: 0 0 2px; padding-left: 20px; color: var(--text-muted); font-size: .82rem; line-height: 1.45; }
.obs-how li { margin: 3px 0; }
@media (min-width: 700px) { .obs-item { padding: 11px 14px 8px; } .obs-value { font-size: 1.6rem; } }
`;

module.exports = { observationStyles, instrumentsTable, instrumentsPage, filingsPage, filingLine, formLabel, FORM_LABEL, recentBriefs, tradeShowcase, resolvePage, instrumentPage, sourcesPage, watchlistsPage, editorHome, editorInstrument, errorPage, when, staleBadge, grouped, clip };
