# Tasks: `store-sync`

Spec: [`docs/specs/SPEC-store-sync.md`](../docs/specs/SPEC-store-sync.md) · Plan: [`plan.md`](plan.md).
"SC n" = the spec's success criterion n. Every task is TDD: failing test first. Focused tests:
`pnpm --filter @woolrus/core test -- <path>`. Each task ends green on `pnpm lint && pnpm typecheck` plus the
focused tests; checkpoints run the full green set. Add a `Done:` line (2–3 lines) under each finished task.

## Phase 1: Foundation

- [x] **T1: WooCommerce HTTP adapter**
  - Interface `StoreAdapter`, `StoreError` kinds (`unauthorized`, `notFound`, `unreachable`, `notWooCommerce`,
    `rateLimited`, `badResponse`) → `errors.sync.*` keys, Zod response schemas (`passthrough`, `"" → null`),
    `createStoreAdapter(config)` on Node `fetch` with basic auth, `per_page=100`, GMT dates, 30 s timeout, retry on
    429/5xx ×3 with backoff and `Retry-After`. Fixtures recorded from the dev store (`:8090`) into `__fixtures__/`.
  - Acceptance: fixtures parse (SC 12); 429→200 retries honouring `Retry-After`; 401 → `unauthorized`; non-Woo URL
    → `notWooCommerce`; no credential in any log line. Live test (`WOO_LIVE=1`, skipped in CI) runs `ping`,
    `getUnits`, one page of orders.
  - Verify: `pnpm --filter @woolrus/core test -- adapters/woocommerce`; `WOO_LIVE=1` run against `pnpm stack:up`.
  - Files: `core/src/adapters/woocommerce/{adapter,errors,schemas,http}.ts`, `http.test.ts`, `__fixtures__/*`.
  - Deps: none · Size: M
  - Done: `core/src/adapters/woocommerce/{adapter,errors,schemas,http}.ts` (exported from core's index), tests in
    `http.test.ts` + `schemas.test.ts`. Parsed objects are camelCase with the untouched JSON on `.raw` (store that as
    `rawPayload`), not `passthrough`. Amounts stay decimal strings (line `price` arrives as a JSON number, normalised);
    `""` → null; dates are `Date`. `createStoreAdapter(config, { fetch, sleep, log })`: inject `log` for pino. `zod`
    added to core (approved). Gotcha: `pnpm --filter @woolrus/core test -- <path>` runs every file; use
    `pnpm --filter @woolrus/core exec vitest run src/<path>` for focused runs.

- [x] **T2: Mapping and fake store**
  - Pure `mapOrder`, `mapProduct`, `mapVariation` per the spec's mapping table; decimal-string → cents without
    floats; weight/dimension unit conversion to oz/in (extend `units.ts`); customer name fallback; bundle
    `bundled_by`; bin from `_bin_location`. `FakeStoreAdapter` with `addOrder/editOrder/cancelOrder/refundOrder/
    addProduct` helpers and paging that matches the HTTP adapter.
  - Acceptance: fixture orders/products map to the expected Woolrus shapes (every mapped field); `"24.00"`→2400,
    `"0.1"`+`"0.2"` sums exact; `lbs`/`kg`/`g`/`oz`, `cm`/`mm`/`m`/`yd` convert; fake pages 230 orders as 3 pages.
  - Verify: `pnpm --filter @woolrus/core test -- sync/mapping units adapters/woocommerce/fake`.
  - Files: `core/src/sync/mapping.ts` (+test), `core/src/units.ts` (+test), `core/src/adapters/woocommerce/fake.ts`
    (+test).
  - Deps: T1 (types) · Size: M
  - Done: `sync/mapping.ts`: `mapOrder(o)`, `mapProduct(p, units)`, `mapVariation(parentWooId, v, units)` return
    Prisma-ready fields with Woo ids (`wooProductId`, `wooVariationId`, `bundleParentWooLineItemId`) for T4 to
    resolve to rows. Addresses use the contracts `OrderAddress` shape; `binLocation`/`barcode` are *absent* (not null)
    unless sent, so a Prisma update leaves them alone. Malformed amounts throw `StoreError("badResponse")`.
    `units.ts` gained `toCents`, `toOunces`, `toInches` and owns the unit lists (adapter re-exports). Schemas now read
    variation `name`, `global_unique_id` (→ barcode) and line `bundled_by`. `adapters/woocommerce/fake.ts` (not in
    core's index): `addOrder({ lines, ...rawFields })` (default line uses an auto-created product), `editOrder`
    (`lines` with `id` keeps a line), `cancelOrder`, `refundOrder(id, amount?)`, `addProduct({ variations })`,
    `failNext(method, error, times)`, `calls`, `now()`; each change ticks the clock 1 s.

- [x] **T3: System actor and the review permission**
  - `Actor.userId: string | null`, exported `systemActor` (`system: "store-sync"`, roles `[ADMIN]`); audit and stage
    events write `actorId` null; history shows "Store sync" (i18n key) for system rows; new permission
    `order.resolveExternalChange` (Admin only). API middleware can't build a system actor.
  - Acceptance: `transition(…, systemActor, cancel)` works and its stage event + audit row have null actor; the
    system actor never satisfies a claim check; history renders the system label; permission matrix test updated;
    all existing workflow tests pass unchanged.
  - Verify: `pnpm typecheck && pnpm --filter @woolrus/core test -- permissions workflow`.
  - Files: `core/src/permissions.ts` (+test), `core/src/audit.ts`, `core/src/workflow/{service,detail}.ts`,
    `contracts/src/orders.ts` (history actor nullable), `i18n` en/es.
  - Deps: none · Size: M
  - Done: `permissions.ts`: `Actor = UserActor | SystemActor`, `systemActor` (frozen, `userId: null`, ADMIN), new
    `order.resolveExternalChange` (Admin via `permissions`). Use `holdsClaim(actor, claimedById)` from
    `workflow/claims.ts` for any claim comparison (null-safe); `transition` refuses every claim move for the system
    actor (`claimRequired`), `claim`/`takeOver` forbid it. History entries gained `bySystem` (= `actorId` null; users
    are never deleted) → "Store sync" label. Web `resolveActor` returns `UserActor`; `createActor` in tests too.
    Surprise: the demo seed writes stage events with a null actor, so demo history now reads "by Store sync".

### Checkpoint 1
- [x] Full green (`pnpm lint && pnpm typecheck && pnpm test && pnpm build`).
- [x] Live adapter test passes against the dev store.
- [x] Review with the user.

## Phase 2: Import

- [x] **T4: First import of new orders**
  - `syncOrders(db, store, { type })` first-run path: write `SyncRun`, fetch every `processing` order, fetch and
    refresh referenced products/variations (24 h staleness) outside the transaction, then per order in one
    transaction under `pg_advisory_xact_lock(wooOrderId)`: upsert products, create `Order` (`PENDING`) +
    `OrderItem`s, stage event `null → PENDING` (`imported`), audit, `recomputePriorities`, notify. Per-order
    failure → rollback + `SyncRunError`; run → `SUCCEEDED` / `PARTIAL` / `FAILED`; missing config →
    `errors.sync.notConfigured`.
  - Acceptance: SC 1 (230 orders, every field, non-processing skipped); SC 3 (failing order leaves no rows, run
    `PARTIAL`, others imported); SC 4 (run row contents, unauthorized → `FAILED`).
  - Verify: `pnpm --filter @woolrus/core test -- sync/orders`.
  - Files: `core/src/sync/{orders,products-upsert,runs}.ts`, `orders.test.ts`, `core/test/factories.ts` (fake
    helpers), `core/src/index.ts`.
  - Deps: T2, T3 · Size: M/L
  - Done: `sync/orders.ts` `syncOrders(db, store | null, { type, now })` → `{ runId, status, imported, skipped,
    failed }` (null store = `notConfigured`). Known orders are skipped for now: T5/T8 hook in at `importOrder`. Per
    order: `fetchOrderCatalog` (outside tx, 24 h freshness) then `upsertCatalog` in the tx (`products-upsert.ts`);
    lock is `pg_advisory_xact_lock(4201002, wooOrderId)`. `runs.ts`: `startRun`/`finishRun`/`recordRunError`;
    run errors are `"<key>"` or `"<key>: <detail>"` (Prisma errors give their code only, never the message). A page
    failure fails the whole run (so T5's watermark can't move past unseen orders). Fake lists newest first.

- [x] **T5: Incremental polling, idempotency and the run lock**
  - Watermark (last finished poll start − 10 min, `modified_after`, any status) + `include=` refetch of the previous
    run's failed ids; skip when `date_modified_gmt ≤ wooModifiedAt`; `withSyncLock(db, "orders"|"products", fn)`
    with `pg_try_advisory_lock`; `alreadyRunning` result writes nothing; webhook-type single-order path
    (`orderIds`).
  - Acceptance: SC 2 (poll twice → one order; poll and single-order import concurrently → one order, one line set);
    SC 3 retry of failed id on next run; SC 8 lock part (second concurrent run → `alreadyRunning`, no run row).
  - Verify: `pnpm --filter @woolrus/core test -- sync/orders sync/lock`.
  - Files: `core/src/sync/{orders,lock}.ts` (+tests).
  - Deps: T4 · Size: M
  - Done: `sync/lock.ts` `withSyncLock(db, "orders"|"products", fn)` → `{ acquired, result }`; it holds
    `pg_try_advisory_xact_lock` in one open transaction (≤ 1 h), not a session lock, because Prisma's pool can't
    unlock on the same connection. `syncOrders` returns `{ status: "alreadyRunning" }` for a refused poll;
    `orderIds` runs skip the run lock. Known + newer orders go through `updateKnown` (only `wooStatus`,
    `wooModifiedAt`, `rawPayload` for now; result count `updated`): T8 replaces its body with change detection.
    Tests drive the window with `now: store.now()` / `later(ms)` because the fake's clock is 2026-10-01.

- [x] **T6: Worker jobs, interval, CLI and `enqueue`**
  - Spike first: pg-boss `send` with the Prisma transaction as executor (`enqueue(tx, queue, payload)` in core;
    add `pg-boss` to `@woolrus/core`). Queues `orders.webhook`, `products.sync` added to `jobs.ts`. Worker: 1-minute
    `orders.sync` tick, pure `isPollDue(lastStart, intervalMinutes, now)`, manual always runs; `pnpm sync:pull` /
    `sync:products` CLI scripts calling core directly and printing the run summary.
  - Acceptance: SC 8 interval part (`isPollDue` table test; manual bypasses); `pnpm sync:pull` against the dev
    stack imports the dev store's processing orders and a second run imports nothing new; enqueue inside a rolled-
    back transaction leaves no job (dev stack check).
  - Verify: focused tests; `pnpm stack:up && pnpm db:migrate && pnpm sync:pull` twice; worker log on `pnpm dev`.
  - Files: `core/src/{jobs,enqueue}.ts`, `core/package.json`, `apps/worker/src/{main,cli}.ts`,
    `apps/worker/package.json`, root `package.json`.
  - Deps: T5 · Size: M
  - Done: `core/src/enqueue.ts` `enqueue(tx, queue, payload, { singletonKey? })`: a never-started `PgBoss` on a
    Prisma adapter (`tx.$queryRawUnsafe`), built per call; checked on the dev stack (commit → 1 job, rollback → 0).
    `sync/schedule.ts`: `isPollDue`, `pollIfDue(db, store, { reason })` (any-status last start counts) and
    `configuredStore(db, opts)`. Worker ticks `orders.sync` every minute; `apps/worker/src/cli.ts` (`pnpm sync:pull`,
    built to `dist/cli.mjs`). Gotcha: the env fallback for Woo keys needs `NODE_ENV=development`, now set in the
    worker's `dev` and `sync:pull` scripts. `orders.webhook` / `products.sync` queues exist with no handler yet.

### Checkpoint 2
- [x] Full green.
- [x] Dev stack: worker imports the dev store's orders into the Pending queue within the interval; they show in
      `/queue/pending` with products, priority and item counts.
- [ ] Review with the user.

## Phase 3: Store-side changes

- [x] **T7: Order diff and the untouched predicate (pure)**
  - `diffOrder(stored, incoming)` → `ChangeSummary` (status, addresses, note, customer, shipping method, lines
    added/removed/quantity, refunds); untracked meta differences produce an empty diff. `isUntouched(snapshot)`
    per the spec (PENDING, no live claim, nothing picked, no packages/voids/issues/notes).
  - Acceptance: table tests for every tracked field and for meta-only noise; `isUntouched` false for each blocking
    condition alone.
  - Verify: `pnpm --filter @woolrus/core test -- sync/changes`.
  - Files: `core/src/sync/changes.ts` (+test).
  - Deps: T2 · Size: S
  - Done: `sync/changes.ts`: `diffOrder(stored, incoming)` over `DiffableOrder` (a `Pick` of `MappedOrder` + lines),
    `hasChanges(diff)`, `isUntouched(snapshot, claimExpiryMinutes, now)` (any void/note/issue row counts, undone too).
    `refunds` is `{ from, to }` refunded cents, not per line: Woo's order payload has no refund lines (spec said
    `lineItems[]`). `mapOrder` gained `refundedCents` (createOrder strips it). **For T8:** `wooStatus` and
    `rawPayload` always follow the store, so a re-diff while flagged must not take its "stored" status/refunds from
    them; keep the baseline (e.g. in `externalChangeSummary`) or the status change vanishes from the second diff.

- [x] **T8: Change rules during import**
  - Known-and-newer orders run the spec's change table: untouched + cancelled/refunded/failed → `transition(cancel)`
    with `systemActor`; started + cancelled → hold ("Cancelled in store") + flag; untouched + edits → apply in place
    (lines added/removed/re-quantified, priority recomputed, audited `order.externalChange.applied`); otherwise flag
    (`externalChangeDetectedAt`, summary `{ diff, incoming }`, `version` bump, notify). `wooStatus`,
    `wooModifiedAt`, `rawPayload` always updated. A later change while flagged replaces the diff.
  - Acceptance: SC 5, one test per table row plus the "second edit replaces the diff" case.
  - Verify: `pnpm --filter @woolrus/core test -- sync/orders sync/apply`.
  - Files: `core/src/sync/{orders,apply}.ts` (+tests).
  - Deps: T5, T7 · Size: M
  - Done: `sync/apply.ts` `reconcileKnownOrder(tx, orderId, incoming, now)` (called from `updateKnown` under the Woo
    order lock, after the incoming order's products are upserted, so T9 needs no HTTP). Summary JSON is
    `ExternalChangeSummary { diff, incoming (no rawPayload; dates as ISO strings), baseline: { wooStatus,
    refundedCents } }`; T9 must parse dates back. Store reverting a flagged change clears the flag. Lines are made by
    `sync/lines.ts` `createLines(tx, orderId, items)` (links existing bundle parents too); reuse it in Apply. System
    reasons are message keys `sync.reason.imported` / `sync.reason.cancelledInStore` (spec said
    `errors.sync.cancelledInStore`); web shows them via `useReasonText()` in `apps/web/src/lib/reasons.ts`.

- [x] **T9: Apply / Dismiss in core and API**
  - `applyExternalChange` / `dismissExternalChange` (`order.resolveExternalChange`, `expectedVersion`, dismiss reason
    required); line absorbability rules with an unmet list (`errors.sync.cannotApply`); header fields always apply;
    status never applied. Contract + router `orders.externalChange.{apply,dismiss}`; `getOrder` gains
    `externalChange: { detectedAt, diff } | null` (never `incoming`).
  - Acceptance: SC 6 (apply success, each refusal case, stale version, dismiss reason, forbidden for the four floor
    roles); detail output contains no `incoming` data.
  - Verify: `pnpm --filter @woolrus/core test -- sync/review workflow/detail`; contracts tests.
  - Files: `core/src/sync/review.ts` (+test), `core/src/workflow/detail.ts`, `contracts/src/orders.ts`,
    `apps/web/src/server/router.ts`, `i18n` en/es.
  - Deps: T3, T8 · Size: M
  - Done: `sync/review.ts` `applyExternalChange` / `dismissExternalChange` (return `Order`; API shape via
    `orderMutations.{apply,dismiss}ExternalChange`) and `externalChangeOf(order)` → `{ detectedAt, diff } | null`.
    `OrderView.externalChange` is now that object (mutations' `OrderDetail` keeps the boolean); new action
    `resolveExternalChange` in `allowedActions` when flagged. Unmet keys `errors.sync.unmet.*`; a non-flagged order →
    `errors.sync.notFlagged`. `apply.ts` exports `headerFields` / `writeLineChanges`. Dismiss keeps the order; the
    store's version is re-diffed only on its next edit.

- [x] **T10: External-change banner on order detail**
  - Warning banner listing changes in words (old → new, per field and line), Apply / Dismiss (reason dialog) for
    users allowed to; unmet list when refused; "status changes are handled with Cancel / Resume" note when the diff
    has a status change. Tablet-sized targets; en + es.
  - Acceptance: banner hidden when not flagged; Apply refreshes the page state; refusal shows the unmet list; non-
    admins see the banner without buttons.
  - Verify: `pnpm --filter @woolrus/web build`; manual on dev stack (edit an order in the dev store after starting
    picking, run sync, review); covered by e2e in T17.
  - Files: `apps/web/src/app/(app)/orders/[id]/{page,external-change-banner}.tsx`, `i18n` en/es.
  - Deps: T9 · Size: S/M
  - Done: `orders/[id]/external-change-banner.tsx` (mounted under the header in `order-view.tsx`); buttons show on
    `allowedActions` `resolveExternalChange`. Reuses `ReasonDialog` / `unmetOf` (now exported from
    `order-actions.tsx`); `formatAddress` moved to `orders/[id]/address.ts`. Checked on the dev stack (order 15):
    refusal list, Apply, Dismiss. Gotchas: DaisyUI `.alert` is a column grid, so add `flex flex-col` to stack its
    content; a Woo REST PUT that only touches lines + shipping may not bump `date_modified_gmt`, so sync misses it.

### Checkpoint 3
- [x] Full green.
- [x] Dev stack: cancel an untouched order in the dev store → it leaves the queue; cancel a picking order → On Hold
      with the banner; edit an address on a picking order → banner → Apply works.
- [ ] Review with the user.

## Phase 4: Webhooks and catalog

- [ ] **T11: Webhook receiver**
  - `receiveWooWebhook(db, { headers, rawBody })`: ping → 200; no secret or bad `X-WC-Webhook-Signature`
    (base64 HMAC-SHA256, constant-time) → 401; other topics → 200 ignored; 1 MB limit; `InboundWebhook` insert +
    `enqueue(orders.webhook)` in one transaction; duplicate delivery id → 200, no job. Route
    `apps/web/src/app/api/webhooks/woocommerce/route.ts` (thin). Worker handler runs the single-order sync and sets
    `processedAt` / `error`.
  - Acceptance: SC 7 every case; the handler refetches from the store rather than using the payload.
  - Verify: `pnpm --filter @woolrus/core test -- sync/webhooks`; curl a signed payload at the dev server.
  - Files: `core/src/sync/webhooks.ts` (+test), route, `apps/worker/src/main.ts`.
  - Deps: T5, T6 · Size: M

- [ ] **T12: Product catalog sync**
  - `syncProducts(db, store)` (`SyncRun` `PRODUCTS`, under `withSyncLock("products")`): page all products, fetch
    variations for variable ones, upsert; never delete; never overwrite customs, Lumexia, or barcode (unless the
    store sends one). Worker: `products.sync` nightly 03:00 + manual.
  - Acceptance: SC 9; run row written; a product removed from the store is left as-is.
  - Verify: `pnpm --filter @woolrus/core test -- sync/products`; `pnpm sync:products` on the dev stack.
  - Files: `core/src/sync/products.ts` (+test), `apps/worker/src/{main,cli}.ts`.
  - Deps: T2, T6 · Size: S/M

### Checkpoint 4
- [ ] Full green.
- [ ] Dev stack: with the webhook registered in the dev store, a new order there appears in Pending within seconds.

## Phase 5: Admin surfaces and finish

- [ ] **T13: Sync API**
  - Core reads/commands + contract + router: `sync.status` (`order.read`; last poll, last webhook, `stale` = no
    successful poll for 3 × interval or last failed), `sync.runs` (cursor, type filter), `sync.runErrors`,
    `sync.run` (`{ target: "orders"|"products" }`, idempotency key, enqueues), `sync.testConnection`
    (`{ ok, units } | { ok: false, messageKey }`).
  - Acceptance: SC 10 — allowed + forbidden test per procedure, `sync.status` for every role and 401 signed out; a
    test serialises every response and searches for the consumer key/secret.
  - Verify: `pnpm --filter @woolrus/core test -- sync/status`; contracts tests.
  - Files: `core/src/sync/status.ts` (+test), `contracts/src/sync.ts`, `contracts/src/index.ts`,
    `apps/web/src/server/router.ts`.
  - Deps: T5, T6 · Size: M

- [ ] **T14: Nav indicator and Sync page**
  - Nav "Synced n min ago" from `sync.status`, refreshed on the live stream, red "Sync failing" / "Sync late" when
    stale (FR-SYNC-07). `/sync` (Admin, nav entry): Sync orders now / Sync products now, runs table with expandable
    errors (Woo id links to the order when it exists), last webhook received. en + es.
  - Acceptance: non-admins see the indicator but no Sync link and get forbidden at `/sync`; buttons enqueue and the
    new run appears.
  - Verify: `pnpm --filter @woolrus/web build`; manual on dev stack; e2e in T17.
  - Files: `apps/web/src/app/(app)/layout.tsx`, `apps/web/src/app/(app)/sync/{page,sync-runs}.tsx`, nav component,
    `i18n` en/es.
  - Deps: T13 · Size: M

- [ ] **T15: URL origin change clears secrets**
  - `updateSettings`: origin change (scheme + host + port) of `wooStoreUrl` / `lumexiaBaseUrl` with secrets set
    clears that integration's secrets in the same transaction, audits `secret.clear` with `reason: "urlChanged"`,
    returns the cleared names. Path-only change keeps them.
  - Acceptance: SC 11.
  - Verify: `pnpm --filter @woolrus/core test -- settings/service`.
  - Files: `core/src/settings/service.ts` (+test), `contracts/src/settings.ts` (cleared names in output).
  - Deps: none · Size: S

- [ ] **T16: Integrations card: Test connection, webhook URL, URL-change confirm**
  - WooCommerce card gets Test connection (translated result), the webhook URL with copy button and setup steps, and
    a confirm dialog when a URL origin change will clear saved keys (Lumexia card gets the confirm too).
  - Acceptance: Test connection shows OK with units against the dev store and a translated error with a wrong
    secret; saving a new host after confirming shows the secrets as Not set.
  - Verify: `pnpm --filter @woolrus/web build`; extend `apps/web/e2e/settings.spec.ts`.
  - Files: `apps/web/src/app/(app)/settings/**` (integrations card), `apps/web/e2e/settings.spec.ts`, `i18n` en/es.
  - Deps: T13, T15 · Size: M

- [ ] **T17: E2E, docs and status**
  - `apps/web/e2e/sync.spec.ts` (SC 13): Test connection OK → Sync orders now → dev store's processing orders in
    Pending, nav shows fresh time; a signed webhook for an edited, started order shows the banner. Edit
    `docs/decisions.md` (cron endpoint dropped, URL change clears secrets, pg-boss in core) and `SPEC-settings.md`
    (URL rule); update the spec with anything learned; status table → `in progress` (done at ship).
  - Acceptance: SC 13, SC 14 (full green + Playwright desktop and tablet).
  - Verify: `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm --filter @woolrus/web test:e2e`.
  - Files: `apps/web/e2e/sync.spec.ts`, `docs/decisions.md`, `docs/specs/SPEC-settings.md`,
    `docs/specs/SPEC-store-sync.md`, `SPEC.md`.
  - Deps: all · Size: M

### Checkpoint 5 (complete)
- [ ] Every success criterion in the spec has a test.
- [ ] Full green + Playwright.
- [ ] Ready for `/agent-skills:review`.
