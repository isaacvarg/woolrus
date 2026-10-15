# Tasks: `workflow`

Plan: [`plan.md`](plan.md) · Spec: [`SPEC-workflow.md`](../docs/specs/SPEC-workflow.md). "SC n" = spec success
criterion n. Every task ends green for the packages it touches (`pnpm --filter <pkg> test`, `pnpm typecheck`,
`pnpm lint`). UI tasks also run the Playwright suite.

## Phase 1: Foundation

- [x] **T1: Schema columns + test factories** (S/M)
  - Acceptance: one migration adds `Settings.claimExpiryMinutes Int @default(30)` and `Product.physical Boolean
    @default(true)`; init constraints untouched. `test/factories.ts` builds orders with lines, voids, packages,
    package items, rates and labels in any status.
  - Verify: `pnpm db:generate`, `pnpm --filter @woolrus/db migrate:check`, a factory smoke test in core.
  - Files: `packages/db/prisma/schema/{system,catalog}.prisma`, new migration, `packages/core/test/factories.ts`
    (+ test).
  - Deps: none.

- [x] **T2: `claimExpiryMinutes` in settings** (S/M)
  - Acceptance: in `AdminSettings`, `PublicSettings` and the update contract (integer 5–480, rejected outside the
    range). The General form edits it, with en/es strings.
  - Verify: contract + service tests extended; the settings e2e still passes.
  - Files: `packages/contracts/src/settings.ts` (+test), `packages/core/src/settings/service.ts` (+test),
    `apps/web/src/app/(app)/settings/general-form.tsx`, `packages/i18n/src/messages/{en,es}.json`.
  - Deps: T1.

- [x] **T3: State machine (pure)** (S)
  - Acceptance: the transition table from the spec as data. `canTransition` / `transitionFor(from, to, kind)`.
    Every (from, to, kind) is tested; unlisted ones give `errors.workflow.illegalTransition`, and terminal states
    are left only by force (SC 1).
  - Verify: `pnpm --filter @woolrus/core test machine`.
  - Files: `packages/core/src/workflow/machine.ts` (+test), the i18n error key.
  - Deps: none.

- [x] **T4: Gates (pure evaluate + snapshot loader)** (M)
  - Acceptance: `evaluateGate(kind, snapshot)` returns unmet conditions with message keys for picked, packed,
    verified, shippable and noLiveLabels. Active quantity subtracts voids that aren't undone. Non-physical and
    zero-active lines are skipped. Over-packing fails. `loadGateSnapshot(tx, orderId)` uses the factories (SC 2, 9).
  - Verify: unit tests per condition + one integration test of the loader.
  - Files: `packages/core/src/workflow/gates.ts` (+test), i18n keys.
  - Deps: T1, T3.

### Checkpoint A
- [x] `pnpm lint && pnpm typecheck && pnpm test` green; migration applied in dev; review with the user.

## Phase 2: Transitions and claims

- [x] **T5: Transition engine + stage completions** (M)
  - Acceptance: `transition()` in one transaction does permission → lock + version check → machine → claim rule →
    gate → update → `OrderStageEvent` + audit → `pg_notify`. `beginPicking` (sets the claim), `completePicking`,
    `completePacking` and `completeQa` (need a live claim; clear it). A refused gate changes nothing (SC 3). Two
    concurrent calls with the same version → one `stale` (SC 5). Allowed/forbidden tests per role (SC 4).
  - Verify: `pnpm --filter @woolrus/core test workflow/service`.
  - Files: `packages/core/src/workflow/{service,notify}.ts` (+test), `packages/core/src/index.ts`, i18n keys.
  - Deps: T4.

- [x] **T6: Hold, resume, cancel, force, repack, ship** (S/M)
  - Acceptance: hold from each stage needs a reason and resume returns to `heldFromStatus`. Cancel and repack are
    refused with a live label. Force needs `order.forceStatus` and a reason, and skips gates. `ship` and `repack`
    are exported for `shipping` and take a caller `tx`. One stage event + one audit row per move (SC 7, 8).
  - Verify: core integration tests.
  - Files: `packages/core/src/workflow/service.ts` (+test).
  - Deps: T5.

- [x] **T7: Claims** (M)
  - Acceptance: `claim`, `claimMany` (≤ 50, all or nothing, id-ordered locks), `release`, `takeOver` (needs
    `confirm: true`), `touchClaim`, `isClaimLive` with lazy expiry from settings. Holder's name in the conflict
    error. Audited, no stage event (SC 6).
  - Verify: core integration tests, including expiry with an injected clock.
  - Files: `packages/core/src/workflow/claims.ts` (+test), `service.ts` (claimedAt refresh), i18n keys.
  - Deps: T5, T2.

- [x] **T8: Orders mutation contract + router** (M)
  - Acceptance: `packages/contracts/src/orders.ts` has every mutation from the spec's API table, with
    `expectedVersion`, reason rules and `OrderDetail` output (the shape is used by T11). The router has one line
    each. The `/api/v1` OpenAPI lists them. A refused gate surfaces the `unmet` list in the error `data`.
  - Verify: contract schema tests; `pnpm build`; a `curl`/`/api/v1` smoke against dev for one refused
    `completePacking`.
  - Files: `packages/contracts/src/{orders,index,base}.ts` (+test), `apps/web/src/server/router.ts`,
    `apps/web/src/server/orpc.ts` (pass `unmet` through).
  - Deps: T6, T7.

- [ ] **T9: SSE live-updates endpoint (risk spike)** (M)
  - Acceptance: `GET /api/events/orders` refuses signed-out callers and streams `order_changed` events (id + status
    only) within 2 s of a commit, with a 25 s heartbeat. One `LISTEN` client per process, closed on shutdown
    (SC 11). **Ask before adding `pg` to `apps/web` if it isn't already resolvable there.**
  - Verify: an integration test (subscribe, run a transition, receive the event); manual `curl -N` in dev.
  - Files: `apps/web/src/server/live.ts`, `apps/web/src/app/api/events/orders/route.ts`, `apps/web/package.json`?.
  - Deps: T5.

### Checkpoint B
- [ ] Green. Every mutation works through `/api/v1` against dev data. SSE delivers events. Review with the user.

## Phase 3: Reads and UI

- [ ] **T10: Queue reads** (M)
  - Acceptance: `listQueue` (five stages + ON_HOLD, keyset paging, number-prefix/customer search, priority then
    age, active physical unit count, stage age, SLA breach, live claim only, external-change flag) and
    `queueCounts`. Contract + router (SC 10, except the benchmark).
  - Verify: core integration tests.
  - Files: `packages/core/src/workflow/queries.ts` (+test), `packages/contracts/src/orders.ts`, `router.ts`.
  - Deps: T7.

- [ ] **T11: Detail, history, All Orders reads** (M)
  - Acceptance: `getOrder` with `allowedActions` per actor (tested for each role/claim combination), `getOrderHistory`
    (stage + claim/takeover audit, actor/station names, newest first), and `listOrders` (filters, sort, offset paging,
    total). Contract + router.
  - Verify: core integration tests.
  - Files: `queries.ts` (+test), `packages/core/src/workflow/actions.ts` (+test), contract, router.
  - Deps: T10.

- [ ] **T12: Dev demo orders seed** (S)
  - Acceptance: `pnpm db:seed` adds about 30 orders across all statuses in dev (never in production), including a
    non-physical Rush Order product line, an Express shipping method, old orders and one held order. Re-running
    doesn't duplicate them.
  - Verify: run the seed twice in dev; check counts.
  - Files: `packages/db/prisma/seed.ts` (+ `seed-orders.ts`).
  - Deps: T1.

- [ ] **T13: Nav counts + queue pages** (M)
  - Acceptance: nav entries Pending…Ready, On Hold (with counts) and All Orders. `/queue/[stage]` has search,
    a priority badge, red stage age past SLA, the claim holder, the external-change icon and tablet-sized rows.
    Pending rows have **Begin Picking**. Stale-version errors show a toast and refetch. en/es strings.
  - Verify: Playwright: begin picking moves the order out of Pending.
  - Files: `apps/web/src/app/(app)/layout.tsx`, `queue/[stage]/{page,queue-table}.tsx`, i18n,
    `apps/web/e2e/workflow.spec.ts`.
  - Deps: T8, T10, T12.

- [ ] **T14: Order detail page** (M/L)
  - Acceptance: `/orders/[id]` has the header, claim banner + take-over confirmation, buttons from `allowedActions`,
    and dialogs for hold/cancel (reason) and force (status + reason). A refused completion shows the unmet list.
    Read-only lines (non-physical lines marked) and a history panel.
  - Verify: Playwright: takeover with two users; hold → On Hold queue → resume; admin cancel; gate refusal shown.
  - Files: `orders/[id]/{page,order-actions,history-panel}.tsx`, `components/ui` dialog primitive if missing, i18n,
    e2e.
  - Deps: T11, T13.

- [ ] **T15: All Orders page** (S/M)
  - Acceptance: `/orders` has search, a status filter, sortable columns and pagination (TanStack Table) in the URL
    query, and row → detail.
  - Verify: Playwright: search and sort.
  - Files: `orders/{page,orders-table}.tsx`, i18n, e2e.
  - Deps: T11, T13.

### Checkpoint C
- [ ] Green + Playwright. A demo-seeded dev stack is walkable from Pending to QA through the UI. Review with the user.

## Phase 4: Priority

- [ ] **T16: Priority evaluator + rule schemas** (S)
  - Acceptance: a Zod discriminated union for `lineItem` / `shippingMethod` / `orderAge`, and a pure
    `computePriority` (highest enabled match, else 0). Rush Order SKU → 2 (SC 10).
  - Verify: unit tests per condition type and boundary.
  - Files: `packages/contracts/src/priority-rules.ts` (+test), `packages/core/src/workflow/priority.ts` (+test).
  - Deps: none (can run in parallel with Phase 2/3).

- [ ] **T17: Rules service, recompute, job** (M)
  - Acceptance: list/create (idempotent)/update/delete/reorder with `settings.manage`, audited. A change recomputes
    open orders in the same transaction, without a version bump, with a notify. `recomputePriorities` is exported
    for `store-sync`. A pg-boss `orders.recomputePriority` job runs every 5 min in the worker. Contract + router.
  - Verify: core integration tests (an age threshold crossed by advancing the clock); worker build.
  - Files: `packages/core/src/workflow/priority-rules.ts` (+test), `packages/core/src/jobs.ts`,
    `apps/worker/src/main.ts`, `router.ts`.
  - Deps: T16, T10.

- [ ] **T18: Priority rules admin page** (M)
  - Acceptance: `/settings/priority-rules` (only for `settings.manage`) has a list, an add/edit dialog, an enable
    toggle, reorder and delete with confirmation. The demo seed adds the matching rules. en/es.
  - Verify: Playwright: adding a rule reorders the Pending queue; a Picker gets forbidden.
  - Files: `settings/priority-rules/{page,rules-manager}.tsx`, `layout.tsx`, `seed-orders.ts`, i18n, e2e.
  - Deps: T17, T13.

## Phase 5: Live and finish

- [ ] **T19: Client live invalidation** (S)
  - Acceptance: a `useOrderEvents()` hook subscribes once per tab and invalidates the queue/counts/order query keys.
    While disconnected, `refetchInterval` is 30 s. It reconnects with backoff.
  - Verify: Playwright: browser B's queue updates when browser A begins picking, without a reload (SC 12).
  - Files: `apps/web/src/lib/live.ts`, `(app)/layout.tsx` (provider), e2e.
  - Deps: T9, T13.

- [ ] **T20: E2E coverage, perf benchmark, docs** (M)
  - Acceptance: every SC 12 journey is in `workflow.spec.ts` (desktop + tablet). An integration benchmark with
    2,000 open orders gets `listQueue` p95 under 1 s (SC 10). The spec state, SPEC.md status and any spec
    deviations are updated.
  - Verify: full green: `pnpm lint && pnpm typecheck && pnpm test && pnpm build` + Playwright.
  - Files: `apps/web/e2e/workflow.spec.ts`, `packages/core/src/workflow/queries.bench.test.ts`, `SPEC.md`,
    `docs/specs/SPEC-workflow.md`.
  - Deps: all.

### Checkpoint D (complete)
- [ ] Every spec success criterion has a test; green + Playwright; ready for `/agent-skills:review`.
