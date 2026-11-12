# AGENTS.md — OpenVibe.Trade

## Project overview

OpenVibe.Trade (`https://openvibe.trade`) is an **informational** market context product: instruments
and aliases with deterministic resolution, timestamped market observations with their sources, SEC
filings and other source documents, private watchlists and alerts, short AI briefs from filed numbers,
and editor-written/edited context. It is explicitly **not** custody, order execution, a marketplace or
investment advice (ADR-025); the disclaimer is on every page.

- **Entry:** `server/index.js`; app `server/app.js`; port `4860`, service id `trade`.
- **API:** `server/http/api.js` (`/api/v1`), `api`/`editor`/`private` route groups, `discovery.js`,
  `actor-limits.js`; pages `server/http/pages.js` and `server/render/` (`home.js`, `layout.js`,
  `views.js`, `short.js`); `public/js/passkey-signin.js` is the only own script, CSS in `public/css`.
- **Domain:** `server/domain/` — `instruments.js`, `observations.js`, `documents.js`, `facts.js`,
  `mapping.js`, `context.js`, `briefs.js`/`market-briefs.js`/`ai-briefs`, `alerts.js`, `watchlists.js`,
  `ingest.js`, `reading.js`, `source-status.js`, `account-data.js`, `indexing.js`, `urls.js`.
- **Clients and events:** `server/clients/sec.js` (SEC ticker/XBRL data), `server/clients/ai.js`,
  `server/events/consumer.js` (Sources items, account export/deletion), SDK outbox.
- **Docs:** `docs/marketplace-open-question.md` (the historical marketplace branch); `SECURITY.md` has
  the threat review.

## Owns, does not own

Owns its nine charter tables in `ov_trade`: `trade_instruments` (symbol, name, kind, exchange, SEC
CIK, currency, status, published context revision), `trade_instrument_aliases` (tickers/CIKs/names
with a normalised resolution key), `trade_watchlists` (private, one owner), the alert rules/deliveries,
observations, documents, context revisions, briefs, reviews, shares and outbox.

Does not own: money, custody, orders, escrow, listings or advice (none exist here; money is Billing's,
ADR-012/025); source items (Sources owns ingestion, robots, terms, items and their removals — Trade
keeps metadata keyed by item id and follows revisions/removals); identity (Network); notifications
(Network renders/delivers them from `trade.alert.triggered`; Trade sends no email).

## Who calls it, what it calls

Public reads (`GET /instruments`, `/instruments/:symbol`, observations, documents, `/sources`) are
anonymous and cacheable. People sign in with Network SSO for watchlists/alerts; editors use
instrument and context management; services use audience `openvibe.trade` tokens with
`trade.instrument.resolve`, `trade.instrument.manage`, `trade.observation.write` (services only) and
`trade.context.read`. SDK `openvibe-sdk/trade` is the client surface. Trade calls Network (JWKS, SSO),
Sources (items, revisions, removals; `svc:trade` created the `sec-company-tickers` source), SEC's own
tickers/XBRL, AI (`trade.summarize_market_context`, labelled output) and Events (outbox:
`trade.alert.triggered`, context/brief events).

## Database and migrations

PostgreSQL `ov_trade` through `openvibe-sdk/db` (PgBouncer for the app, direct owner role for
migrations); migrations `0001..0010` cover instruments, observations, documents, alerts, AI/market
briefs, shares, the brief batch and the outbox rejection index. Applied at boot; only add tables and
columns — never edit one that has run, and a rollback must keep working. Tests use PGlite or, with
`TRADE_TEST_STORE=pg`, the PostgreSQL containers.

## Auth and privacy

Only verified Network RS256 JWTs (offline against JWKS) and service tokens for audience
`openvibe.trade`. A bad service token is refused, never downgraded to anonymous; identity never comes
from a body or query, and `X-OV-*` headers are ignored for browsers. Watchlists and alerts are the
person's own; a share is read-only. Public pages are cacheable with no personal data; a person's page
is `private, no-store`. `/internal/events` is signed (v2) and loopback-only; account export/deletion
covers every table with a person column, leaving contributions without the person id.

## Deploy

`sudo ovhost deploy trade` (git-checkout: fetch, fast-forward `/opt/openvibe.trade`, install on a
lockfile change, restart, wait for `/api/ready`; rollback `sudo ovhost rollback trade --to <sha>`).
Unit `openvibe-trade.service` on `127.0.0.1:4860`, env `/etc/openvibe/trade.env`, database `ov_trade`;
the release migrates at boot.

## Commands and tests

```bash
npm ci
npm run dev                 # http://127.0.0.1:4860
npm test                    # every test/*.test.js, PGlite + mock Network/Sources
npm test -- schedule        # only matching files
npm run test:pg             # the same on PostgreSQL
```

`test/run.js` uses `openvibe-shared/test-runner` (60 s, serial); PGlite plus in-process Network and
Sources mocks, never the network. Coverage includes instrument/alias resolution, observations and
freshness, alerts and their scheduling, filings/documents and citations, AI/context briefs, watchlists
and shares, the route inventory/scope test, capabilities/contracts, CSP/analytics, account data and
the pages.

## Conventions and pitfalls

- CommonJS, 4-space indent, single quotes, semicolons; problem+json errors and escaped HTML.
- **Information only:** no route may hold or move value, execute an order, escrow, list a marketplace
  item, or read as advice. The route-inventory test and ADR-025 enforce the scope; a new "trade"
  feature that touches money belongs in Billing, not here.
- **Every observation shows when it was observed, when it was retrieved and which source stated it.**
  A missing value is null/"not known", never zero or inferred.
- **Resolution is deterministic:** a ticker or CIK names exactly one instrument (unique), a name may be
  ambiguous and must return candidates; never pick one silently.
- **AI briefs are labelled and cite the filed numbers/documents**; they are not reviewed by a person.
  Editor context is reviewed; drafts are only visible with `?all=1` to an editor and the AI workflow
  input route is capability-guarded.
- **Sources revisions and removals win:** when Sources retracts an item, Trade's copy follows and a
  citation to it must not survive as if still sourced.
- **Passkeys/sign-in never expose the token** to the page: the session is a Network cookie (or Bearer
  for the API); `public/js/passkey-signin.js` only drives the browser ceremony.
