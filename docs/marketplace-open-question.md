# Open question: the historical marketplace branch

**Status:** unresolved. Recorded, not implemented. Binding decision: [ADR-025 (Marketplace and
commerce scope)](https://github.com/OpenVibers/OpenVibe.Contracts/blob/main/docs/adr/ADR-025-marketplace-scope.md).

## The two branches

The design history of `openvibe.trade` has two branches. Both are kept here on purpose, so a later
summary cannot quietly drop one (roadmap §15.13 obligations, backlog item 134, anti-goal 29: "Do
not erase the unresolved Trade marketplace branch; decide it explicitly").

1. **Informational product — built.** Instruments and aliases, market observations with their
   observation and source timestamps, filings and other source documents, private watchlists,
   alert rules, and reviewed context. This repository implements this branch only.
2. **Marketplace — not built, not decided.** The older branch treated Trade as a marketplace:
   listings between users, orders, and custody of what is exchanged. The roadmap also names a later,
   separate extension for an asset / mod / theme / plugin / service marketplace. Nothing of either
   exists in any OpenVibe repository.

## What ADR-025 decided

- OpenVibe.Trade is informational.
- Excluded: custody, order execution, escrow, listings between users, and personalised financial
  advice.
- The marketplace branch stays an **open question**. It is neither accepted nor rejected for all
  time: it is out of scope until a new ADR decides it.

## What reopening it requires

A new ADR, written before any code, that covers at least:

- **Legal basis:** which jurisdictions, which licences or registrations (a marketplace for
  financial instruments is a regulated activity; one for digital goods has consumer-protection,
  tax and platform-liability duties), and who is the merchant of record.
- **Billing flows:** money moves only through OpenVibe.Billing (ADR-012). The ADR must say which
  journal accounts a sale touches, how a seller is paid, and how refunds and chargebacks unwind.
- **Economic classification (ADR-012):** what is traded, and its class. Game state never bridges to
  money, loyalty units are not transferable and cosmetics are not tradable unless a new ADR says
  otherwise.
- **Fraud, disputes and abuse:** listing moderation, dispute handling, escrow or not, seller
  verification, sanctions screening where money is involved.
- **Ownership:** which service would own it. It would not be this informational service by
  default: ADR-025 keeps Trade informational, and a marketplace may belong in a separate service
  with its own threat review.

## How this repository keeps the question open (and closed to accidents)

- No table, route, capability or event for orders, listings, carts, checkout, escrow, wallets or
  custody exists. `test/route-inventory.test.js` walks the live Express stack in CI and fails if a
  route path, handler name, capability id or event type carries that vocabulary.
- Context text that recommends buying, selling or holding, or gives price targets, is refused
  (`server/domain/context.js`).
- Every page carries the disclaimer "Information only — not investment advice; no trading here."

If the marketplace question is ever decided in favour of building something, that decision lands as
an ADR in OpenVibe.Contracts first, and this document is updated to point at it.
