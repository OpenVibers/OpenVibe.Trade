# OpenVibe.Trade

> Informational watchlists, sourced market context and alerts. No custody, no order execution.

**Status:** alpha (roadmap Wave 19). The service runs and its tests pass. It is **not deployed**,
`openvibe.trade` still shows its placeholder from OpenVibe.Sites, and its capabilities and service
manifest are proposals that the next openvibe-contracts release has to include. No market data
feed is configured yet (see "What it shows today").
**Domain:** `openvibe.trade` · **Port:** 4860 · **Service id:** `trade`
**Plan:** OpenVibe End-to-End Realignment & Implementation Plan, revision 3 (20 Sep 2026), §12.11;
roadmap Wave 19, §15.13, §29, §32. **Binding decision:** ADR-025 (marketplace and commerce scope).
**License:** AGPL-3.0 (same as every OpenVibe service).

> **Information only — not investment advice; no trading here.** This sentence is on every page.

## Purpose

An informational product: instruments and their aliases with deterministic resolution, market
observations that always show when they were observed, when they were retrieved and which source
stated them, filings and other source documents from OpenVibe.Sources, private watchlists, alert
rules, and short context written by editors (or drafted by OpenVibe.AI and reviewed by a person).

Per ADR-025 Trade is informational **only**. There is no custody, no order execution, no escrow, no
listing between users and no personalised financial advice — not as a feature, not as an endpoint,
not as a table. The historical marketplace branch is recorded as an open question in
[docs/marketplace-open-question.md](docs/marketplace-open-question.md), not implemented.

## Owns

The nine charter tables (roadmap §15.13) live in Trade's own SQLite (`TRADE_DB_PATH`):

| Charter table | What it is |
|---|---|
| `trade_instruments` | Symbol (canonical, upper case), name, kind, exchange, SEC CIK, trading currency, status, and which context revision is published. |
| `trade_instrument_aliases` | Tickers, CIKs and names with their normalised resolution key. A ticker or CIK names exactly one instrument (unique index); a name may be shared (resolution is then ambiguous). |
| `trade_watchlists` | Private, one owner (`usr_…`). |
| `trade_watchlist_items` | Instruments on a watchlist, with an optional note. |
| `trade_market_observations` | Value (the decimal exactly as stated), unit, currency, period, `observed_at`, source key, Sources item, source URL, the source's own reference, `retrieved_at`, optional `max_age_sec`, who recorded it. **Immutable** (triggers abort UPDATE and DELETE); unique per `(source_key, source_ref)`. |
| `trade_source_documents` | Filings and other documents from Sources items: form type, filer, CIK, accession, URL, the source's own dates, `retrieved_at`, licence/terms notes, removal state. |
| `trade_alert_rules` | `threshold` (metric, above/below, threshold, unit, currency), `filing_type` (form types) or `new_document`, one owner. |
| `trade_alert_deliveries` | One row per `(rule, trigger kind, trigger id)` under a UNIQUE key — the idempotency of alerts. |
| `trade_context_revisions` | `openvibe-publishing/revisions` (prefix `trade_context`): immutable revisions of an instrument's context with authorship, `as_of` and citations of Trade's documents and observations. |

Other tables in the same database:

- Package companions: `trade_context_drafts`, `trade_context_revision_purges`,
  `trade_context_reviews` (a person's review of an AI draft) and `trade_index_revisions` (the
  Search document sequencer).
- `trade_source_status`: freshness of each source (Sources' health plus Trade's own clock).
- `trade_sync_state`: the Sources cursor, the last error and counters of what was skipped and why.
- `event_outbox` (SDK outbox) and `idempotency_receipts` (SDK inbox for signed webhook deliveries).

## Does not own

- **Money, custody, orders, escrow, listings, advice.** None exist here (ADR-025). Money belongs to
  OpenVibe.Billing (ADR-012).
- **Source items.** OpenVibe.Sources owns ingestion, robots, terms and the items; Trade keeps the
  metadata it shows, keyed by the item id, and follows revisions and removals.
- **Identity.** OpenVibe.Network: SSO, subjects, service principals.
- **Notifications.** Network renders and delivers them from `trade.alert.triggered` (ADR-020).
  Trade sends no email.
- **Search.** OpenVibe.Search indexes what Trade sends through Events.
- **AI generation.** OpenVibe.AI runs `trade.summarize_market_context`; Trade makes no provider calls.
- **Discussion.** Community (not wired yet; no comments here).

## What works

- **Instruments and resolution.** Editors add instruments (form or API). Resolution is exact and
  deterministic, in a fixed order: CIK (all digits, optionally `CIK…`) → ticker (symbol, then ticker
  aliases) → exact normalised name (diacritics, case, punctuation, `&`, `/DE/` and trailing corporate
  words normalised). Several instruments with the same name → `ambiguous`, candidates listed, none
  chosen. No fuzzy or prefix matching. `/i/aapl` and a ticker alias answer 301 to `/i/AAPL`.
- **Observations.** Recorded by a first-party feed (`POST /api/v1/observations`,
  `trade.observation.write`) or from Sources items that state a value (`fields.metric`, `value`,
  `unit`, `observed_at`, a symbol or CIK). `observed_at` and `retrieved_at` are required and never
  defaulted; a replay is `200 created:false`; the same reference with a different value is `409`.
  **No observation → no number:** the page says "No observations have been recorded for X, so no
  number is shown."
- **Freshness.** Per source: fresh only while the last successful fetch is younger than the source's
  window (Sources' `stale_after_sec`, else `TRADE_DEFAULT_STALE_AFTER_SEC`), computed with Trade's
  clock. A stale value stays visible with its timestamps and a **"stale since <time>"** badge; a
  source Trade has never heard of is "freshness unknown". An observation can also carry its own
  `max_age_sec`. `trade.source.stale` / `.recovered` are emitted on transitions only. If Sources or
  the sync fails, nothing is invented: the failure is recorded, and the data ages into "stale".
- **Documents.** The sync pulls `category=trade` items by cursor. SEC EDGAR filings (the seeded
  `sec-xbrl-filings` source) are recognised by their `sec.gov/Archives/edgar/data/<CIK>/<accession>/`
  URL: CIK and accession come from the URL, the form type from the item summary (the feed's
  `<description>`) when it looks like one, the filer from the title. A filing without a date says
  "not stated by the source". Items that match no instrument are skipped and counted, never stored.
  A Sources removal hides the document (the row stays as the record).
- **Watchlists.** Private per person; plain forms and the API. Anyone else gets 404.
- **Alerts.** `threshold` rules fire on a crossing (armed → fired → re-armed when a newer
  observation no longer meets the condition; late observations never fire; unit and currency must
  match exactly, no conversion). `filing_type` and `new_document` fire once per newly seen document;
  item revisions never re-fire. Each delivery is one row and one `trade.alert.triggered` event
  (visibility `subject`, subject = the owner), in the same transaction as the triggering
  observation or document.
- **Context.** Editors write Markdown context citing documents and observations (`as_of` = the
  newest cited time, never the time of writing), publish, retract, and review. OpenVibe.AI output is
  a labelled AI-generated draft, never attributed to a person, that cannot be published before a
  person on the editor list approves it. Text that recommends buying, selling or holding, or gives
  price targets, is refused (`context.advice_refused`).

### What it shows today

Trade shows only what a source stated. OpenVibe.Sources' one trade source (`sec-xbrl-filings`) is
**disabled** until a person verifies its terms, and it carries filings, not prices. So a fresh
deployment has no instruments (editors add them), no documents until the source is enabled, and
**no numbers at all** until a market data source that states values exists — which is correct.

### Routes (server-rendered, useful without JavaScript)

| Route | What |
|---|---|
| `/` | instruments, recent documents, feeds |
| `/resolve?q=` | resolution; one match → 302 to the instrument |
| `/i/:symbol`, `/i/:symbol.json` | the instrument page (observations with timestamps and sources, context with disclosure, documents, source freshness, watch/alert forms), and the same data as JSON |
| `/i/:symbol/documents.xml`, `.atom`, `.json` | the instrument's documents as RSS, Atom and JSON Feed |
| `/feed.xml`, `/atom.xml`, `/feed.json` | recent documents across instruments |
| `/sources` | freshness of every source and of the sync |
| `/watchlists` | your watchlists, alert rules and deliveries (private, noindex, `private, no-store`) |
| `/editor`, `/editor/i/:symbol` | the editor (plain forms, editors only) |
| `/sitemap.xml` → `/sitemaps/instruments.xml` | indexable instrument pages only |
| `/robots.txt`, `/llms.txt` | crawler policy (private paths disallowed) and orientation |
| `/terms`, `/privacy`, `/dmca` | openvibe-shared legal pages |
| `/auth/*` | sign-in; the same session layer as Blog and Community |
| `/api/health`, `/api/ready`, `/release.json`, `/metrics` | health, readiness, release, metrics (loopback only) |
| `POST /internal/events` | signed OpenVibe.Events deliveries (`sources.*`), host-local |

### Discoverability (roadmap §32)

- Instrument pages go through the `openvibe-publishing/seo` gate. Financial information is a
  **sensitive** category: a page is `noindex` (`unreviewed_sensitive`) until a person-reviewed
  context is published, `noindex` when its newest monetary observation is older than
  `TRADE_PRICE_MAX_AGE_SEC` (`stale_price`), and `thin` below `TRADE_GATE_MIN_WORDS` of context.
- The sitemap lists indexable instrument pages only, `lastmod` = the context's real publication time.
- JSON-LD: `WebPage` (+ `Corporation` with `tickerSymbol` for equities) and breadcrumbs, from real
  fields only. No price, offer, rating or invented date.
- Every instrument page has a JSON twin with the same data (`/i/:symbol.json`).

### Caching (nothing personal in shared caches)

- `public, max-age=60` only for pages identical for everyone, served to anonymous viewers.
- `private, no-store` for everything personal (signed-in views, watchlists, alerts, editor), every
  error, every form response and the whole API. HTML varies on `Cookie` and `Authorization`.
- Feeds and sitemaps are public for 5 minutes and contain public documents and pages only.

### API `/api/v1` (problem+json errors)

| Capability | Routes |
|---|---|
| (public) | `GET /instruments`, `GET /instruments/:symbol`, `GET /instruments/:symbol/observations`, `GET /instruments/:symbol/documents`, `GET /sources` |
| `trade.instrument.resolve` | `GET /instruments/resolve?q=&kind=` |
| `trade.instrument.manage` | `POST /instruments`, `PATCH /instruments/:symbol`, `POST /instruments/:symbol/aliases` (people: editors) |
| `trade.observation.write` | `POST /observations` (services only) |
| `trade.context.read` | `GET /instruments/:symbol/context` (`?all=1` drafts), `GET /instruments/:symbol/context/input` (the AI workflow input) |
| `trade.context.propose` | `POST /instruments/:symbol/context` (`X-OV-Origin: ai` for AI drafts; editors) |
| people on the editor list | `POST /instruments/:symbol/context/revisions/:n/review` |
| `trade.watchlist.read` / `.create` / `.update` / `.delete` | `GET/POST /watchlists`, `GET/PATCH/DELETE /watchlists/:id`, `PUT/DELETE /watchlists/:id/items/:symbol` |
| `trade.alert.read` / `.create` / `.delete` | `GET /alerts`, `GET /alerts/deliveries`, `POST /alerts`, `DELETE /alerts/:id` |

Service tokens use audience `openvibe.trade`, one capability per route; private data needs
`X-OV-Subject` (the person the service acts for). Browsers with a Network JWT are judged by ownership
and the editor list. The charter's `trade.watchlist.create|update`, `trade.instrument.resolve`,
`trade.alert.create|delete` and `trade.context.read` are all 3-segment ids here; `read`, `delete`,
`manage`, `observation.write` and `context.propose` are additions. Proposals:
[docs/capabilities-proposal/](docs/capabilities-proposal/) and
[docs/service-manifest-proposal.json](docs/service-manifest-proposal.json). Until the release,
grants for these ids are decided locally with the contracts library's matching rule
(`server/auth/capabilities.js`).

### Events (SDK outbox, same transaction as the change)

| Event | Visibility | Notes |
|---|---|---|
| `trade.observation.created` | public | instrument, metric, value, unit, currency, observed_at, retrieved_at, source |
| `trade.alert.triggered` | subject (the owner) | delivery id, rule, instrument, trigger with its timestamps and source; data only, no rendered text (ADR-020) |
| `trade.source.stale`, `trade.source.recovered` | public | on transitions only, with `stale_since` |
| `trade.index_document.upserted` / `.deleted` | internal | `search.index-document@1` documents of listable instrument pages, tombstones otherwise |

Consumed: `sources.item.created|updated|removed` and `sources.fetch.failed` through the signed
webhook, as a wake-up for the cursor sync (the webhook is not durable truth; the sync is).

### OpenVibe.AI seam (`trade.summarize_market_context`)

1. The AI (or its caller) reads `GET /api/v1/instruments/:symbol/context/input` — the workflow input
   with numbered sources: each observation and document with `observed_at`/`published_at`,
   `retrieved_at` and its staleness.
2. The AI service posts the output to `POST /api/v1/instruments/:symbol/context` with
   `X-OV-Origin: ai`, `workflow { id, run_id }`, `input_sources` and `output` (the workflow's
   schema). Citations are indices into `input_sources` and must exist.
3. The revision is an AI-generated **draft**: labelled, noindex, not shown to readers until a person
   on the editor list approves it at `/editor/i/:symbol`.

## Depends on

- **Packages** (pinned by release tarball): `openvibe-contracts` v0.19.0, `openvibe-publishing`
  v0.2.0 (revisions, authorship, seo, index-hooks, ssr), `openvibe-shared` v1.3.0 (chrome, app icon,
  footer, legal, release, metrics, ready), `openvibe-sdk` v0.2.2 (events outbox and inbox, service
  tokens).
- **OpenVibe.Network:** SSO (OAuth client `trade`, redirect `https://openvibe.trade/auth/callback`),
  JWKS, client-credentials tokens.
- **OpenVibe.Sources:** `sources.item.read` and `sources.source.read` (category `trade`).
- **OpenVibe.Events:** `events.event.publish`; a subscription for `sources.*` delivering to
  `http://127.0.0.1:4860/internal/events` (optional; the sync also runs on a timer).
- **OpenVibe.Search:** consumes `trade.index_document.*` (Search's `*.index_document.*` subscription;
  `trade` must be in `SEARCH_EVENT_OWNERS`).
- **OpenVibe.Network notifications:** a consumer of `trade.alert.triggered` (not built yet: until it
  exists, deliveries are recorded and visible at `/watchlists`, and the events wait in Events).
- **OpenVibe.AI:** optional, for drafts.

### Grants the Network must hold

Each grant is `[client, capability, audience]`:

- `[trade, events.event.publish, openvibe.events]`
- `[trade, sources.item.read, openvibe.sources]`
- `[trade, sources.source.read, openvibe.sources]`
- For OpenVibe.AI to deliver drafts: `[ai, trade.context.read, openvibe.trade]` and
  `[ai, trade.context.propose, openvibe.trade]`
- For a first-party market data feed, when one exists: `[<feed client>, trade.observation.write, openvibe.trade]`
- For Network (or another first-party surface) to show a person's watchlists and alerts:
  `[network, trade.watchlist.read, openvibe.trade]`, `[network, trade.alert.read, openvibe.trade]` (optional)

## Acceptance (automated: `npm test`)

| Charter / roadmap / ADR-025 requirement | Test |
|---|---|
| **No execution, custody or advice endpoint exists**: a route-inventory test walks the live Express stack and fails on any route path, handler name, capability id or event type with order/buy/sell/execute/custody/wallet/escrow/checkout/listing semantics; every route has a named handler; a negative control proves it bites. | `test/route-inventory.test.js` |
| Every datum exposes observation and source timestamps; **no number without an observation**; times are required, never defaulted; observations immutable and idempotent per source reference. | `test/observations.test.js` |
| **Stale feeds shown as stale** (injected clock): "stale since" = last success + window; unknown freshness is not "current"; transitions emit once; a Sources outage invents nothing; `stale_price` in the gate. | `test/freshness.test.js` |
| **Alerts idempotent per triggering observation** (and per document): replayed observations, re-evaluation, replayed sync pages and item revisions deliver nothing new; crossing semantics; privacy of rules; no email. | `test/alerts.test.js` |
| **Watchlists never leak**: private cache headers, noindex, 404 for others, CSRF form tokens, capability + X-OV-Subject for services, never in sitemaps, feeds, Search or events. | `test/privacy.test.js` |
| AI output is a labelled draft, noindex until a person approves it; advice refused; editor forms; sitemap/Search follow publication. | `test/context.test.js` |
| Sources mapping (SEC filings), deterministic resolution, cursor replay, removals, signed webhook with inbox. | `test/sync.test.js` |
| Disclaimer on every page; no-JS pages; JSON twin = HTML; feeds without invented dates; robots/llms/sitemaps; readiness; the marketplace question is documented and nothing of it exists. | `test/pages.test.js` |
| Proposals valid against the released schemas and equal to what the code enforces and emits; every envelope valid. | `test/contracts.test.js` |

## Launch rule

This repository alone does not make the product live. `openvibe.trade` keeps its placeholder on
[OpenVibers/OpenVibe.Sites](https://github.com/OpenVibers/OpenVibe.Sites) until all of plan §12.12
exists. Status against each point:

1. **Runtime, health, readiness, observability:** done.
2. **Canonical identity and auth:** done (Network SSO, subjects, service tokens).
3. **SSR public routes useful without JS:** done.
4. **Persistence and end-to-end workflows:** done in tests; in production there is no market data
   source yet and the filings source is disabled in Sources (see "What it shows today").
5. **Capability and event registration against OpenVibe.Contracts:** proposals are in `docs/`,
   waiting on the release.
6. **Migration and seed strategy, threat review, sitemap/robots/feed behaviour:** done. Nothing to
   migrate (no current implementation); no seed (editors add instruments); threat review below.
7. **Acceptance tests:** done.

The launch release removes `openvibe.trade` from `OpenVibe.Sites/sites.json`, switches routing
(nginx vhost, DNS, TLS), flips the Network hub entry and registers maturity in the ecosystem
registry, atomically. A placeholder never counts as an implemented service.

## Security and threat review

- **Scope (ADR-025):** nothing moves or holds value. The route-inventory test is in CI; context that
  reads as advice is refused; the disclaimer is on every page.
- **Identity:** only verified Network JWTs (offline RS256 against JWKS) and service tokens for
  audience `openvibe.trade`; a bad service token is refused, never downgraded to anonymous; identity
  never comes from a body or query; `X-OV-*` headers are ignored for browsers.
- **Private data:** watchlists and alert rules are owner-only (404 otherwise), `private, no-store`,
  noindex, disallowed in robots, absent from sitemaps, feeds, Search documents and events (the
  alert event goes to its owner only, visibility `subject`).
- **CSRF:** SameSite=Lax session cookie plus an HMAC form token (`TRADE_FORM_SECRET`) on every form.
- **XSS:** all HTML through `openvibe-publishing/ssr` auto-escaping; context Markdown through its
  safe subset; external links `rel="nofollow noopener"`; CSP from helmet.
- **Honesty:** observation and retrieval times are required; values are stored exactly as stated;
  observations are immutable; documents never get invented dates; JSON-LD only from real fields;
  AI drafts are labelled and gated by a person's review.
- **SSRF:** Trade fetches only its configured Network and Sources hosts; it never fetches a URL from
  a source item (it links to it).
- **Webhook:** HMAC-verified raw body, inbox per event id, host-local only (nginx returns 404).
- **Abuse:** rate limits on `/auth`, private forms and `/api/v1`, in Express and in the nginx
  reference; per-person limits of 20 watchlists × 200 instruments and 100 alert rules.
- **Known gaps:** the advice filter is a phrase guard, not a guarantee (editors remain accountable);
  there is no market data source yet; Network does not consume `trade.alert.triggered` yet; Search
  documents exist only for instruments with reviewed context.

## Development

```bash
fnm exec --using=22.22.1 npm install
fnm exec --using=22.22.1 npm test          # temp databases and in-process mocks, no network
fnm exec --using=22.22.1 npm run dev       # http://localhost:4860 (set OV_OAUTH_CLIENT_SECRET to sign in)
```

## Deploy (for the lead)

1. **Code and config:** code at `/opt/openvibe.trade`, `npm ci --omit=dev` on Node 22.
   Create `/etc/openvibe/trade.env` (0600) from `.env.example` with `OV_OAUTH_CLIENT_SECRET`,
   `TRADE_EDITORS`, `TRADE_FORM_SECRET`, `EVENTS_URL=http://127.0.0.1:4300`,
   `BASE_URL=https://openvibe.trade`, `OV_SOURCES_INTERNAL_URL=http://127.0.0.1:4720` and, if the
   Events subscription is created, `TRADE_EVENTS_WEBHOOK_SECRET`.
2. **Network:** register (or seed) the OAuth client `trade` with redirect
   `https://openvibe.trade/auth/callback`, set its secret, add the grants above.
3. **Events (optional):** a subscription for consumer `trade`, topic `sources.*`, endpoint
   `http://127.0.0.1:4860/internal/events`, secret = `TRADE_EVENTS_WEBHOOK_SECRET`.
4. **Search:** add `trade` to `SEARCH_EVENT_OWNERS` if it is not there.
5. **systemd:** install `deploy/systemd/openvibe-trade.service` (port 4860, `StateDirectory=openvibe-trade`).
6. **nginx:** install `deploy/nginx/openvibe.trade.conf` (`/metrics` and `/internal/` never proxied).
7. **Contracts:** release the capability and manifest proposals; then CI's contracts check can drop
   `continue-on-error`.
8. **Data:** editors add instruments at `/editor`. Filings appear once `sec-xbrl-filings` is enabled
   in Sources (after a person verifies its terms); numbers appear only once a market data source
   exists and states them.
9. **Launch:** in the same release, remove `openvibe.trade` from OpenVibe.Sites and flip the Network
   hub entry (see the launch rule).

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).
