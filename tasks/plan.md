# Implementation Plan: `store-sync`

Spec: [`docs/specs/SPEC-store-sync.md`](../docs/specs/SPEC-store-sync.md) (approved 2026-10-15). Branch
`store-sync/order-import`. Tasks and their acceptance criteria are in [`todo.md`](todo.md).

## Overview

Pull paid WooCommerce orders and their products into Woolrus through an adapter, keep them current by polling and
webhooks, catch store-side cancellations and edits (auto-apply on untouched orders, hold/flag otherwise), and give
admins a sync log, a Sync now button, Test connection and an Apply / Dismiss review. The order is: adapter
first (riskiest: real HTTP, real payloads), then the import slice end to end, then change detection, then webhooks
and the catalog, then the admin surfaces and the e2e.

## Dependency graph

```
T1 adapter (http, schemas, errors) ──┐
                                     ├─ T2 mapping + fake ──┐
T3 system actor + permission ────────┼──────────────────────┼─ T4 first import ─ T5 incremental + lock ─ T6 worker, CLI, enqueue
                                     │                      │                         │
                                     │                      └─ T7 diff (pure) ─ T8 change rules in import
                                     │                                                │
                                     │                                  T9 review core + API ─ T10 banner UI
                                     │
                                     └─ T11 webhooks (needs T5, T6) · T12 catalog sync (needs T2, T6)
T13 sync API (needs T5, T6, T1) ─ T14 nav indicator + Sync page
T15 settings: URL origin clears secrets (independent) ─ T16 Integrations card: Test connection + webhook URL (needs T13)
T17 e2e + docs (needs all)
```

## Architecture decisions (from the spec, restated for implementers)

- **Adapter boundary:** `StoreAdapter` in `core/src/adapters/woocommerce/adapter.ts`. Every sync service takes it
  as an argument; tests use `FakeStoreAdapter`. Only `createStoreAdapter(config)` knows about HTTP.
- **No new HTTP library:** Node `fetch` + a small retry loop. **`pg-boss` added to `@woolrus/core`** (same
  12.38.0 already in the worker), approved with the spec, so web can enqueue in the caller's transaction.
- **Per-order transactions** with `pg_advisory_xact_lock(wooOrderId)`; **run-level** session advisory lock in
  `withSyncLock` so worker, CLI and manual runs never overlap. Products are fetched *before* the order transaction
  and written *inside* it (FR-SYNC-03 atomicity without holding a transaction open across HTTP).
- **Import writes a stage event directly** (`null → PENDING`), not through `transition`, since there's no prior
  status; auto-cancel and auto-hold go through `transition` with `systemActor`.
- **Watermark** is derived from `SyncRun` rows (last finished `ORDERS_POLL` start − 10 min); no new column.
- **Interval** is checked at run time on a 1-minute tick; no rescheduling when Settings change.
- **No Prisma schema change.** If one turns out to be needed, stop and ask.

## Phase summary

| Phase | Tasks | Ends with |
|---|---|---|
| 1 Foundation | T1–T3 | Adapter talks to the dev store; mapping is pure and tested; system actor exists |
| 2 Import | T4–T6 | `pnpm sync:pull` and the worker import the dev store's orders into Pending |
| 3 Changes | T7–T10 | Store cancels/edits are applied, held or flagged; admins Apply / Dismiss in the UI |
| 4 Webhooks + catalog | T11–T12 | Signed webhooks import within seconds; nightly product refresh |
| 5 Admin + finish | T13–T17 | Sync page, nav indicator, Test connection, URL-change secret clearing, e2e, docs |

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Real Woo payloads differ from docs (string numbers, empty strings, missing images, `product_id: 0`) | High | T1 records fixtures from the dev store first; schemas are permissive (`passthrough`, `nullable`, `"" → null`) and tested against fixtures |
| Production store has bundles/ACF/bin meta we don't model (open questions 1–2) | Med | Raw payloads stored; mapping isolated in one pure file so a later tweak is one function + fixture |
| Webhook + poll race creating duplicate orders | High | Per-order advisory lock + unique `wooOrderId`; SC 2 concurrency test in T5 |
| Widening `Actor.userId` to nullable ripples through workflow code | Med | T3 is done early and alone; `tsc` finds every use; existing workflow tests must stay green |
| Long first import holds locks / transactions | Med | One transaction per order; products fetched outside; a 230-order fake run in tests |
| pg-boss `send` with a Prisma transaction as executor | Med | T6 spikes it first; fallback is enqueue-after-commit with the inbox row as the durable record (webhooks) — raise with the user if needed |
| Date skew between Woo and our clock losing changes | Med | 10-minute overlap on `modified_after`; idempotent skip on `wooModifiedAt` |
| Test DB has no pg-boss schema | Low | Core tests use an injected `enqueue` fake; worker integration is verified on the dev stack |

## Parallelization

Single-agent by default. If parallel sessions are used: T3 and T15 are independent of the adapter work; T12
(catalog) and T11 (webhooks) can run in parallel after T6; T10 and T14 are UI-only once their APIs exist.

## Open questions (carried from the spec, none block the start)

1. Bin location meta key in production (default `_bin_location`).
2. Bundles / ACF in production orders (needs read-only access or a sample export — ask-first).
3. Rush Order `virtual` flag (check on the first real product sync).
4. First production import window: all `processing` orders (default) or last N days.
