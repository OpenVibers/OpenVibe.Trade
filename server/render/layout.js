'use strict';

/**
 * Page shell. Every page is server-rendered through this and is complete without JavaScript:
 *   - the document is openvibe-publishing/layout's (openvibe-shared/shell page())
 *   - <head>: title, description, canonical and robots from the indexability gate's decision
 *     (there is no default that makes a page indexable), Open Graph/Twitter, JSON-LD from real
 *     fields only, feed links, the shared app icon, the site stylesheet and the boost marker
 *   - the persistent disclaimer, above the content on every page:
 *     "Information only — not investment advice; no trading here."
 *   - the OpenVibe Frame: theme-loader, web runtime, navbar and footer from the Network (progressive), a
 *     <noscript> navigation bar and the server-rendered shared footer (openvibe-shared)
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const layout = require('openvibe-publishing/layout');
const { escapeHtml: esc } = require('openvibe-publishing/ssr');
const frame = require('openvibe-shared/frame');

const NETWORK_URL = 'https://openvibe.network';
const SITE_NAME = 'OpenVibe.Trade';
const DISCLAIMER = 'Information only — not investment advice; no trading here.';
// The site's one-line AI summary: /llms.txt, /llms-full.txt and the home page's ai-summary all use it.
const SITE_SUMMARY = 'Informational market context for about 8,000 US-listed companies: SEC filings as they arrive, the key numbers in them with their periods and sources, and AI briefs that cite every figure they use. Information only — not investment advice; no trading here.';
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

const hashes = new Map();
function assetVersion(rel) {
    if (hashes.has(rel)) return hashes.get(rel);
    let v = 'dev';
    try { v = crypto.createHash('sha256').update(fs.readFileSync(path.join(PUBLIC_DIR, rel))).digest('hex').slice(0, 10); } catch { /* missing asset */ }
    hashes.set(rel, v);
    return v;
}
const asset = (rel) => `/${rel}?v=${assetVersion(rel)}`;

// The deployed release (app.js sets it from openvibe-shared/release): openvibe-shared/boost swaps a page in place only
// between pages of the same release, and does a normal load across a deploy.
let RELEASE = 'dev';
function setRelease(id) { if (id) RELEASE = String(id); }

const NAV_LINKS = [
    { label: 'Companies', href: '/instruments' },
    { label: 'Filings', href: '/filings' },
    { label: 'Sources', href: '/sources' },
    { label: 'Watchlists', href: '/watchlists' },
];

/**
 * o: title, description, decision (required), canonical, type, jsonLd [], feeds [{ type, href, title }],
 *    body (HTML), viewer, config, path, bodyClass, summary (one-line AI summary; with facts, updated
 *    and url it becomes the ai-summary meta and WebPage JSON-LD via openvibe-publishing/layout)
 */
// The Markdown twin of this page (openvibe-shared/agent-layer): the head names it, so a reader that
// already has the HTML finds the twin from it. The twin's address is this page's own address + '.md'.
const agentHeadTags = (o) => {
    const canonical = o.canonical || (o.config && o.config.baseUrl ? `${o.config.baseUrl}${String(o.path || '/').split('?')[0]}` : null);
    return canonical ? require('openvibe-shared/agent-layer').linkHeaderTags(canonical, '/llms.txt').head : '';
};
function renderPage(o) {
    if (!o.decision) throw new TypeError('renderPage needs the gate decision');
    const viewer = o.viewer || { kind: 'anonymous' };
    const signedIn = viewer.kind === 'user';
    const loginNext = encodeURIComponent(o.path || '/');
    const nav = {
        service: 'trade',
        apiBase: NETWORK_URL,
        links: NAV_LINKS,
        history: { type: 'page', title: o.title || SITE_NAME },
        silentLogin: `${o.config.baseUrl}/auth/login?silent=1&next={url}`,
        sessionUrl: '/auth/me',
        loginUrl: '/auth/login?next={path}',           // filled from the current page (boost moves between pages)
        logoutUrl: '/auth/logout?next={path}',   // Sign out in the shared navbar ends this site's session too
        notificationsRealtime: true,   // the bell hears new notifications over OpenVibe.Events (Shared 1.22.0)
    };
    // This site's own account links live in the shared navbar's account menu (the page's account
    // bar below is only for visitors without JavaScript).
    if (signedIn) nav.menu = { before: [...(viewer.editor ? [{ label: 'Editor', href: '/editor', icon: 'fa-pen' }] : []), { label: 'Your watchlists', href: '/watchlists', icon: 'fa-list' }] };
    const footer = { service: 'trade', variant: 'auto', path: o.path, mount: '#ov-footer', brandName: SITE_NAME, updates: '/updates' };   // full on the front page only (Shared 4.19)
    const account = signedIn
        ? `${viewer.editor ? '<a href="/editor">Editor</a> · ' : ''}<a href="/watchlists">Your watchlists</a> · <a href="/auth/logout?next=${loginNext}">Sign out</a>`
        : `<a href="/auth/login?next=${loginNext}">Sign in with OpenVibe</a>`;
    return layout.renderDocument({
        site: 'trade',
        siteName: SITE_NAME,
        lang: o.lang,
        title: o.title ? `${o.title} · ${SITE_NAME}` : `${SITE_NAME} — sourced market information`,
        description: o.description || `Instruments, timestamped observations and filings with their sources. ${DISCLAIMER}`,
        canonical: o.canonical,
        // The head names the page's own Markdown twin (openvibe-shared/agent-layer).
        head: agentHeadTags(o),
        decision: o.decision,
        type: o.type || 'website',
        image: o.image,
        jsonLd: o.jsonLd,
        feeds: o.feeds,
        // openvibe-publishing v1.3.0: the AI summary, its facts and its date reach shell.page's
        // seo.pageSummary (ai-summary meta + WebPage JSON-LD); without one, nothing is emitted.
        summary: o.summary,
        facts: o.facts,
        updated: o.updated,
        url: o.url,
        navbar: nav,
        footer,
        navLinks: NAV_LINKS,
        home: '/',
        css: asset('css/trade.css'),
        styles: o.styles,   // openvibe-shared stylesheet names (the home page's showcase.css)
        release: RELEASE,
        account,
        header: `<p class="disclaimer" role="note"><strong>${esc(DISCLAIMER)}</strong> Every number shows when it was observed and where it came from; stale sources are labelled as stale.</p>`,
        body: o.body,
        shipped: [
            o.path === '/' ? frame.shipped({ service: 'trade', title: `Recently shipped on ${SITE_NAME}` }) : '',
            `<p class="disclaimer disclaimer-foot" role="note">${esc(DISCLAIMER)} OpenVibe.Trade holds no money or assets, takes no orders and gives no personal recommendations.</p>`,
        ].filter(Boolean).join('\n'),
        bodyClass: o.bodyClass,
    });
}

module.exports = { renderPage, asset, assetVersion, setRelease, SITE_NAME, NETWORK_URL, DISCLAIMER, SITE_SUMMARY };
