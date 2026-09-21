# OpenVibe.Trade

> Informational watchlists, sourced market context and alerts. No custody, no order execution.

**Status:** placeholder — planning only, no runnable code yet.  
**Domain:** `openvibe.trade`  
**Plan:** OpenVibe End-to-End Realignment & Implementation Plan, revision 3 (20 Sep 2026), §12.11.  
**License:** AGPL-3.0 (same as every OpenVibe service).

## Purpose

An informational product first: symbol/entity resolution, user watchlists, sourced market/filing/catalyst context, threshold/event alerts and cited AI summaries with visible timestamps. Brokerage, custody or execution are out of scope unless a separate regulated design is approved; the historical marketplace branch is recorded as an open ADR, not implemented here.

## Owns

- `trade_instruments`, `trade_instrument_aliases`, `trade_watchlists`, `trade_watchlist_items`, `trade_market_observations`, `trade_source_documents`, `trade_alert_rules`, `trade_alert_deliveries`, `trade_context_revisions`

## Does not own

- order execution, custody, personalised financial advice (none)
- discussion (Community)

## Planned surfaces

- watchlists, sourced context timelines, alert rules via Notifications, cited summaries stating timestamp/scope

## Data (authority tables / families)

- see above

## Capabilities and events

- `trade.watchlist.create|update`, `trade.instrument.resolve`, `trade.alert.create|delete`, `trade.context.read`

Events: ``trade.observation.created``, ``trade.alert.triggered``, ``trade.source.stale|recovered``

## Depends on

- source registry
- OpenVibe.AI
- Notifications
- Search
- OpenVibe.Events

## Acceptance (must be true before "done")

- every datum exposes observation/source timestamp
- alerts are idempotent per triggering observation
- stale/unavailable feeds are shown as such, never replaced with invented values
- no execution or custody endpoint exists

## Bootstrap / extraction source

No current implementation; Wave 17. ADR required before any commerce/marketplace work (backlog 134).

## Launch rule

This repository does not make the product real, and the domain keeps its placeholder page on
[OpenVibers/OpenVibe.Sites](https://github.com/OpenVibers/OpenVibe.Sites) until all of the
following exist here (plan §12.12):

1. an owning runtime with health/readiness endpoints and observability;
2. canonical identity/auth integration (OpenVibe.Network subjects, scoped service principals);
3. server-rendered or static public routes that are useful without JavaScript;
4. real persistence and end-to-end workflows;
5. capability and event registration against `OpenVibe.Contracts`;
6. a migration/seed strategy, a security/threat review, and sitemap/robots/feed behaviour;
7. acceptance tests proving the advertised functionality.

The launch release removes the domain from `OpenVibe.Sites/sites.json`, switches routing and
registers maturity in the ecosystem registry atomically. A placeholder is never counted as an
implemented service.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).
