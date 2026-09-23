'use strict';

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

function csrfField(token) { return html`<input type="hidden" name="_csrf" value="${token}">`; }

function notice(n) {
    if (!n) return '';
    return html`<p class="notice ${n.error ? 'error' : ''}" role="status">${n.text}</p>`;
}

// ── Home ─────────────────────────────────────────────────────────────────────

function home({ page, recent, urls, sync, pager }) {
    const rows = page.instruments.map((i) => html`<tr>
        <td><a href="${urls.path.instrument(i)}"><strong>${i.symbol}</strong></a></td>
        <td>${i.name}</td><td>${i.kind}</td><td>${i.exchange || html`<span class="muted">not recorded</span>`}</td>
    </tr>`);
    const docs = recent.map((r) => html`<li><a href="${urls.path.instrument(r.instrument)}#${r.document.id}">${r.instrument.symbol}</a>
        ${r.document.form_type ? html`<span class="badge">${r.document.form_type}</span>` : ''} ${r.document.title || r.document.filer_name || 'Untitled document'}
        — ${r.document.published_at ? html`published ${when(r.document.published_at)}` : html`<span class="muted">no publication date stated</span>`}, retrieved ${when(r.document.retrieved_at)}</li>`);
    return html`
<h1>Sourced market information</h1>
<p class="lede">Instruments with the observations and filings that sources published about them. Every value shows when it was observed, when it was retrieved and which source stated it. When a source falls behind, its data is marked stale — it is never replaced with a guess.</p>
<p class="muted">What this site is not: there is no order entry, no brokerage, no custody of money or assets, no marketplace and no personal recommendation here.</p>
<form class="search" method="get" action="/resolve" role="search">
  <label for="q">Find an instrument by ticker, CIK or company name</label>
  <input id="q" name="q" type="search" maxlength="200" required>
  <button type="submit">Find</button>
</form>
<h2>Instruments</h2>
${page.instruments.length ? html`<table class="data"><thead><tr><th scope="col">Symbol</th><th scope="col">Name</th><th scope="col">Kind</th><th scope="col">Exchange</th></tr></thead><tbody>${rows}</tbody></table>
${raw(paginationHtml(pager))}`
        : html`<p class="empty">No instruments have been added yet.</p>`}
<h2>Recent documents</h2>
${recent.length ? html`<ul class="docs">${docs}</ul>` : html`<p class="empty">No documents have been recorded yet.</p>`}
<p>Feeds of recent documents: <a href="/feed.xml">RSS</a> · <a href="/atom.xml">Atom</a> · <a href="/feed.json">JSON Feed</a>. Source freshness: <a href="/sources">sources</a>.${sync && sync.last_ok_at ? html` Last synchronised with OpenVibe.Sources ${when(sync.last_ok_at)}.` : ''}</p>`;
}

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

function observationsTable(instrument, observations) {
    if (!observations.length) {
        return html`<p class="empty" id="no-observations">No observations have been recorded for ${instrument.symbol}, so no number is shown.</p>`;
    }
    const rows = observations.map((o) => html`<tr id="${o.id}" class="${o.freshness.stale ? 'is-stale' : ''}">
        <th scope="row">${o.metric}${o.period ? html` <span class="muted">(${o.period})</span>` : ''}</th>
        <td class="num"><data value="${o.value}">${o.value}</data> ${o.unit}${o.currency && o.currency !== o.unit ? html` <span class="muted">${o.currency}</span>` : ''}</td>
        <td>${when(o.observed_at)}</td>
        <td>${o.source.url ? html`<a href="${o.source.url}" rel="nofollow noopener">${o.source.key}</a>` : o.source.key}</td>
        <td>${when(o.retrieved_at)}</td>
        <td>${staleBadge(o.freshness)}</td>
    </tr>`);
    return html`<table class="data observations">
<caption>Latest observation per metric. Values are exactly as the source stated them.</caption>
<thead><tr><th scope="col">Metric</th><th scope="col">Value</th><th scope="col">Observed</th><th scope="col">Source</th><th scope="col">Retrieved</th><th scope="col">Freshness</th></tr></thead>
<tbody>${rows}</tbody></table>`;
}

function sourcesTable(list, { caption }) {
    if (!list.length) return html`<p class="empty">No sources have reported yet.</p>`;
    const rows = list.map((s) => html`<tr id="source-${s.key}">
        <th scope="row">${s.name || s.key}${s.name && s.name !== s.key ? html` <span class="muted">${s.key}</span>` : ''}</th>
        <td>${s.status === 'fresh' ? html`<span class="badge fresh">current</span>` : s.status === 'unknown' ? html`<span class="badge stale">freshness unknown</span>` : html`<span class="badge stale">stale</span>${s.stale_since ? html` since ${when(s.stale_since)}` : ''}`}</td>
        <td>${when(s.last_success_at, 'never')}</td>
        <td>${s.stale_after_sec ? `${Math.round(s.stale_after_sec / 60)} min` : ''}</td>
        <td>${s.upstream_status || html`<span class="muted">not reported</span>`}</td>
    </tr>`);
    return html`<table class="data sources"><caption>${caption}</caption>
<thead><tr><th scope="col">Source</th><th scope="col">Freshness</th><th scope="col">Last successful fetch</th><th scope="col">Stale after</th><th scope="col">Sources reports</th></tr></thead>
<tbody>${rows}</tbody></table>`;
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

function personalTools(instrument, { viewer, watchlists, csrf, loginHref }) {
    if (!viewer || viewer.kind !== 'user' || !viewer.subject) {
        return html`<section class="personal" aria-labelledby="personal-h"><h2 id="personal-h">Watch this instrument</h2>
<p><a href="${loginHref}">Sign in</a> to add ${instrument.symbol} to a private watchlist or to get an alert when a new document or observation arrives.</p></section>`;
    }
    const options = watchlists.map((w) => html`<option value="${w.id}">${w.name}</option>`);
    return html`<section class="personal" aria-labelledby="personal-h"><h2 id="personal-h">Watch this instrument <span class="badge">private</span></h2>
${watchlists.length ? html`<form method="post" action="/watchlists/item" class="inline-form">${csrfField(csrf)}
  <input type="hidden" name="symbol" value="${instrument.symbol}">
  <label for="wl">Add to watchlist</label><select id="wl" name="watchlist_id">${options}</select>
  <button type="submit">Add</button></form>` : html`<p><a href="/watchlists">Create a watchlist</a> first.</p>`}
<form method="post" action="/alerts" class="alert-form">${csrfField(csrf)}
  <input type="hidden" name="symbol" value="${instrument.symbol}">
  <fieldset><legend>New alert for ${instrument.symbol}</legend>
  <label><input type="radio" name="kind" value="new_document" checked> Any new document</label>
  <label><input type="radio" name="kind" value="filing_type"> New filing of type(s) <input name="form_types" placeholder="10-K, 10-Q, 8-K" maxlength="120"></label>
  <label><input type="radio" name="kind" value="threshold"> Observation
    <input name="metric" placeholder="metric, e.g. price.close" maxlength="80">
    <select name="operator"><option value="above">above</option><option value="below">below</option></select>
    <input name="threshold" placeholder="value" maxlength="40"> <input name="unit" placeholder="unit, e.g. USD" maxlength="20"></label>
  </fieldset>
  <button type="submit">Create alert</button>
  <p class="muted">Alerts are delivered as OpenVibe notifications, once per triggering observation or document. No email is sent.</p>
</form></section>`;
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
<section aria-labelledby="obs-h"><h2 id="obs-h">Observations</h2>${observationsTable(instrument, observations)}</section>
${contextSection(instrument, context, urls, { pending: d.pending, editor: d.viewer && d.viewer.editor })}
${documentsSection(instrument, documents, { pager: d.pager, urls })}
<section aria-labelledby="src-h"><h2 id="src-h">Source freshness</h2>${sourcesTable(sources, { caption: `Sources behind this page. A source is stale when its last successful fetch is older than its window.` })}</section>
${personalTools(instrument, d)}
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
${w.items.length ? html`<table class="data"><thead><tr><th scope="col">Symbol</th><th scope="col">Name</th><th scope="col">Note</th><th scope="col"></th></tr></thead><tbody>
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
${rules.length ? html`<table class="data"><thead><tr><th scope="col">Instrument</th><th scope="col">Condition</th><th scope="col">Created</th><th scope="col"></th></tr></thead><tbody>${ruleRows}</tbody></table>`
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
<h2>Instruments</h2>
<ul>${instruments.map((i) => html`<li><a href="/editor/i/${encodeURIComponent(i.symbol)}">${i.symbol}</a> — ${i.name}</li>`)}</ul>`;
}

function editorInstrument({ instrument, aliases, revisions, documents, observations, csrf, notice: n, kinds, head }) {
    const revs = revisions.map((r) => html`<li class="card">
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

module.exports = { home, resolvePage, instrumentPage, sourcesPage, watchlistsPage, editorHome, editorInstrument, errorPage, when };
