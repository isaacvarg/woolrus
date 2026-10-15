# Spec: `workflow`

**Milestone:** M1 · **Depends on:** — (data model only; reads `settings` for SLA and claim expiry) ·
**Used by:** `store-sync` (creates orders in Pending, sets priority on import), `picking`, `packing`, `qa`,
`shipping`, `exceptions` (voids change what "active" means for gates), `reporting` (stage events) ·
**State:** done

Project-wide commands, structure, code style, testing levels and boundaries are in [`../../SPEC.md`](../../SPEC.md);
this spec only adds what is specific to `workflow`.

## Objective

Make the order's fulfillment state something the server owns. Every status change goes through one place in core
that checks who is acting, whether the move is allowed, whether the stage's gate is met and whether the caller saw
the latest version of the order. That place records the change and tells every open screen about it.

- **SRS:** FR-WF-01…08 (state machine, server-enforced gates, stage history, hold/cancel, claiming, audit),
  FR-LIST-01…06 (stage queues, All Orders, search, priority rules, stage age and SLA, live refresh),
  NFR-REL-04 (optimistic locking), NFR-PERF-01/04 (server-side queue search and paging under 1 s).
  Fixes SRS §7.1 #7 (ship without being Ready) and #13 (hard-coded priority).
- **Users:** every role reads queues and orders. Each stage's role claims and advances orders in its stage, any
  role can put an order on hold, Admins cancel and force a status.
- **Why now:** every floor module (picking, packing, QA, shipping) acts on an order in a given state and needs the
  gates, claims and history to already exist. `store-sync` needs somewhere to put imported orders.

### User stories

1. As a picker, I open the Pending queue and see the most urgent orders first, with rush orders on top. I tap
   **Begin Picking** and the order is mine: someone on another tablet sees my name on it.
2. As a picker doing batch picking (later, `picking`), I claim several orders that share items in one step; either
   all of them become mine or none do.
3. As a packer, I try to send an order to QA before every item is boxed and weighed. The server refuses and tells
   me what's missing, even if I call the API directly.
4. As anyone on the floor, I put an order on hold with a reason ("customer called to change address"). It moves to
   the On Hold queue. Later someone resumes it and it goes back to the stage it was in.
5. As a staff member, I left an order claimed and went to lunch. After the claim expiry it's free for the next
   person. Before then, a colleague can take it over after confirming, and the takeover is recorded.
6. As an admin, I cancel an order or force it to another status with a reason. Both appear in its history.
7. As a supervisor, I open any order and see its history: each stage, who moved it, when and why.
8. As anyone, a queue updates within seconds when another station moves an order; I don't work from a stale list.
9. As an admin, I set priority rules: "line item Rush Order → Urgent", "shipping method contains Express → High",
   "older than 2 days → High". Queues sort by them.

## Scope

**In:**
- The state machine and gates in core: allowed transitions, who may make each, the gate for each stage exit,
  hold/resume, cancel, admin force, repack.
- Claims: claim, batch claim, release, takeover, lazy expiry.
- Optimistic locking on every workflow write (`Order.version`), and an `OrderStageEvent` + `AuditEvent` per change.
- Queue and order reads: one queue per stage plus On Hold, All Orders (search, filter, sort, paging), an order
  detail read model, and the history read.
- Priority rules: an evaluator, admin CRUD, recompute on rule change, a periodic recompute job, and a function
  `store-sync` calls on import.
- Live updates: Postgres `NOTIFY` from core, a Server-Sent Events endpoint, and client cache invalidation with a
  polling fallback.
- UI: queue pages, All Orders, an order detail page (header, read-only items, claim banner, hold/resume/cancel/
  force/takeover actions, history panel), the priority rules admin page, and nav entries with counts.
- One new setting, `claimExpiryMinutes`, and a dev seed of demo orders so the module can be used before
  `store-sync` exists.

**Out (owned elsewhere):**
- The work screens for each stage (pick cards, packing, QA verification, ship list) and their side effects:
  `picking`, `packing`, `qa`, `shipping`. They call this module's transition functions.
- Voiding labels before a repack, and pushing Completed to Woo: `shipping`.
- Detecting and acknowledging external changes from WooCommerce (`Order.externalChange*`): `store-sync`. This
  module only shows the flag on queues and order detail.
- The "no open critical quality issue" condition on QA → Ready: added to that gate by `qa` (it's an edit to this
  spec when `qa` is specified).
- Notes on orders: `notes`. Returns after Completed: `returns`.

## Design

### State machine (`packages/core/src/workflow/machine.ts`, pure)

Statuses (`WorkflowStatus`): `PENDING`, `PICKING`, `PACKING`, `QA`, `READY`, `COMPLETED`, `ON_HOLD`, `CANCELLED`.
`COMPLETED` and `CANCELLED` are terminal.

| Transition | Name | Permission | Claim needed | Gate |
|---|---|---|---|---|
| PENDING → PICKING | `beginPicking` | `order.pick` | no one else's live claim; the actor claims it | — |
| PICKING → PACKING | `completePicking` | `order.pick` | actor holds it | **picked** |
| PACKING → QA | `completePacking` | `order.pack` | actor holds it | **packed** |
| QA → READY | `completeQa` | `order.qa` | actor holds it | **verified** |
| READY → COMPLETED | `ship` | `order.ship` | none (shipping works in batches) | **shippable** |
| READY → PACKING | `repack` | `order.pack` | none | **no live labels**; reason required |
| any non-terminal, not ON_HOLD → ON_HOLD | `hold` | `order.hold` | none | reason required |
| ON_HOLD → `heldFromStatus` | `resume` | `order.hold` | none | — |
| any non-terminal → CANCELLED | `cancel` | `order.cancel` | none | **no live labels**; reason required |
| any → any other | `forceStatus` | `order.forceStatus` | none | skips gates; reason required; never out of COMPLETED into a non-terminal while live labels exist |

- `machine.ts` exports `canTransition(from, to, kind)` and the table above as data. The table is tested
  exhaustively: every (from, to) pair is either listed or rejected with `CONFLICT` / `errors.workflow.illegalTransition`.
- A **live label** is a `ShippingLabel` with status `PURCHASING`, `ACTIVE`, `VOID_REQUESTED` or `VOID_REJECTED`.

### Gates (`packages/core/src/workflow/gates.ts`)

Gates read the order's lines, packages and labels inside the transition's transaction and return a list of unmet
conditions (`{ messageKey, params }`), not a boolean, so the UI can say exactly what's missing. A failed gate throws
`AppError("CONFLICT", "errors.workflow.gateFailed")` with the unmet list attached.

The **active quantity** of a line is `quantity − Σ quantity of its ItemVoids that aren't undone`. Every gate ignores
a line with active quantity 0, and a line whose product is **not physical** (`Product.physical = false`, e.g. the
store's Rush Order product: it changes priority but nothing is picked, packed or shipped).

| Gate | Met when |
|---|---|
| **picked** | Every active line is `PICKED` or `SUBSTITUTED` with `pickedQuantity` = active quantity. `OUT_OF_STOCK` and `PENDING` lines block (a picker voids them first, FR-VOID). |
| **packed** | Σ `PackageItem.quantity` per active line = its active quantity; no line is over-packed; every package has items, a box (or all three override dimensions) and a weight. |
| **verified** | The order has at least one package; every `PackageItem` of the order has `qaVerifiedAt`; every package has exactly one selected `ShippingRate` and one `ACTIVE` label. |
| **shippable** | Status is READY and every package has an `ACTIVE` label (fixes §7.1 #7). |

Gates take nothing from the client: they only read the database. That's what makes "hidden buttons" irrelevant.

### Transition service (`packages/core/src/workflow/service.ts`)

One internal function does every move; the public functions are thin wrappers that pick the transition kind:

```ts
transition(tx, actor, { orderId, expectedVersion, to, kind, reason? }): Promise<OrderDetailDto>
```

Inside one transaction:
1. `assertCan` for the kind's permission.
2. `SELECT … FOR UPDATE` the order. If `version ≠ expectedVersion` → `CONFLICT` / `errors.workflow.stale`
   (the client refetches and shows the new state).
3. Check the transition is allowed and the claim rule (expired claims count as no claim).
4. Run the gate.
5. Update `status`, `statusChangedAt`, `version + 1`, clear the claim (except `beginPicking`, which sets it to the
   actor), set/clear `holdReason`/`heldFromStatus`, set `completedAt` on COMPLETED.
6. Insert `OrderStageEvent { from, to, actorId, stationId, reason }` and `recordAudit(… action: "order.<kind>")`.
7. `pg_notify('order_changed', { id, status })`; Postgres delivers it on commit.

Public functions: `beginPicking`, `completePicking`, `completePacking`, `completeQa`, `ship`, `repack`, `hold`,
`resume`, `cancel`, `forceStatus`. `ship` and `repack` are exported for `shipping` to call inside its own
transaction (`shipping` adds the label and Woo-push side effects). They're not routed by this module.

**Contract with later modules:** a stage module never writes `Order.status` itself. It calls these functions with
its `tx`, so its own writes and the transition commit or roll back together.

### Claims (`packages/core/src/workflow/claims.ts`)

- A claim is `Order.claimedById` + `claimedAt`. A user can hold any number of claims.
- **Expiry is lazy:** a claim is treated as absent once `claimedAt + Settings.claimExpiryMinutes` has passed. No job
  clears it. Reads show it as unclaimed, and the next claim simply overwrites it. Every workflow action by the
  claimer on that order refreshes `claimedAt`, and `touchClaim(tx, actor, orderId)` lets stage modules refresh it
  when someone picks or packs.
- `claim({ orderId, expectedVersion })`: needs the permission for the order's current stage (Pending/Picking →
  `order.pick`, Packing → `order.pack`, QA → `order.qa`). Fails with `CONFLICT` / `errors.workflow.claimedByOther`
  (message includes the holder's name) if someone else holds a live claim. Not allowed for ON_HOLD, READY or
  terminal orders.
- `claimMany({ orders: [{ id, expectedVersion }] })`, up to 50: all or nothing in one transaction, rows locked in
  id order to avoid deadlocks. Each failure is reported per order. This exists now so batch picking (`picking`)
  can rely on it.
- `release({ orderId })`: the holder or an Admin; needs `order.read` even when there's nothing to release.
- `claim`, `takeOver` and `claimMany` refuse a caller who can't claim in any stage with `FORBIDDEN` before
  reading the order, so they learn nothing about it.
- `takeOver({ orderId, expectedVersion, confirm: true })`: same permission as `claim`, and `confirm` must be `true`
  (the UI shows a confirmation naming the current holder). Audited as `order.takeOver` with the previous holder.
- Claims bump `version` and are audited, but don't write a stage event (the status didn't change).

### Priority (`packages/core/src/workflow/priority.ts`)

Levels: `0` Normal, `1` High, `2` Urgent. `Order.priority` stores the level; the UI shows the label.

`PriorityRule.condition` is validated by a Zod discriminated union:

| `type` | Fields | Matches when |
|---|---|---|
| `lineItem` | `match: "sku" \| "name"`, `value` | Any `OrderItem` with active quantity left has that SKU (exact) or name (case-insensitive exact). Covers the store's **Rush Order** product; a fully voided Rush Order line no longer counts. |
| `shippingMethod` | `contains` | `Order.shippingMethod` contains the text (case-insensitive) |
| `orderAge` | `minHours` (1–720) | `now − orderedAt ≥ minHours` |

- An order's priority is the highest `priority` among enabled matching rules, or 0 if none match. `position` only
  orders the admin list.
- `computePriority(order, items, rules, now)` is pure.
- `recomputePriorities(tx, { orderIds? })` updates open orders whose value changed, without bumping `version`
  (priority isn't something a user edits, so it shouldn't make their screen stale) but with an `order_changed`
  notify.
- It runs: when a rule is created, edited, deleted or toggled (same transaction); from a new pg-boss job
  `orders.recomputePriority` every 5 minutes (age rules); and from `store-sync` after import.
- Admin CRUD: `priorityRules.list/create/update/delete/reorder`, permission `settings.manage`.

### Reads (`packages/core/src/workflow/queries.ts`)

- **Queue** `listQueue({ stage, search?, cursor?, limit≤100 })`, where `stage` is one of the five stages or `ON_HOLD`.
  Sorted by `priority desc, orderedAt asc, id` with keyset paging. Search is case-insensitive on order number
  (prefix) and customer name (contains), run in Postgres. Each row has: id, number, customer, item count (Σ
  active quantity), priority, orderedAt, `stageEnteredAt` (= `statusChangedAt`), `slaBreached` (stage age >
  `Settings.stageSlaMinutes[stage]`, if set), claim `{ userName, at }` (live claims only), `externalChange`
  flag, `version`. ON_HOLD rows also show `holdReason` and `heldFromStatus`.
- **All Orders** `listOrders({ search?, statuses?, sort: number|orderedAt|customer|status|priority, dir, page,
  pageSize≤100 })`, offset-paged with a total count.
- **Counts** `queueCounts()`: per-stage counts for the nav.
- **Detail** `getOrder({ id })`: header fields, addresses, lines with active quantity, pick status and `physical`, package
  summary, live claim, hold info, `version`, the external-change flag and `allowedActions` for the caller (computed
  in core from the machine, permissions and claim, so the UI shows only what the server would accept).
- **History** `getOrderHistory({ id })`: stage events plus claim/takeover audit events, newest first, with actor
  and station names (FR-WF-05).
- All need `order.read`.

### Live updates

- Core issues `pg_notify('order_changed', json)` in each workflow transaction (payload: order id and new status,
  no PII).
- `apps/web/src/app/api/events/orders/route.ts`: an authenticated SSE stream (session cookie or bearer). One shared
  `LISTEN` connection per web process fans out to subscribers, with a heartbeat every 25 s. Each heartbeat
  re-checks the session, and the stream ends once it's gone or the user is deactivated.
- The client invalidates the matching TanStack Query keys (queue lists, counts, that order) on each event. If the
  stream is down, queries fall back to `refetchInterval: 30s` until it reconnects. While it's up they still
  refetch every 60 s, for what changes with time and sends no event (SLA breach, claim expiry).

### API (oRPC, `packages/contracts/src/orders.ts`, `priority-rules.ts`)

| Procedure | Route |
|---|---|
| `orders.queue` | `GET /orders/queue/{stage}` |
| `orders.list` | `GET /orders` |
| `orders.counts` | `GET /orders/counts` |
| `orders.get` | `GET /orders/{id}` |
| `orders.history` | `GET /orders/{id}/history` |
| `orders.beginPicking` | `POST /orders/{id}/begin-picking` |
| `orders.completePicking` / `completePacking` / `completeQa` | `POST /orders/{id}/complete-picking` … |
| `orders.hold` / `resume` / `cancel` / `forceStatus` | `POST /orders/{id}/hold` … |
| `orders.claim` / `release` / `takeOver` | `POST /orders/{id}/claim` … |
| `orders.claimMany` | `POST /orders/claim` |
| `priorityRules.list/create/update/delete/reorder` | `/priority-rules…` |

Every mutation takes `expectedVersion`. `create` takes an `idempotencyKey` (project rule 5). Transitions don't need
one: `expectedVersion` already makes a replay fail safely with `stale` rather than act twice. `completePicking/
Packing/Qa` are routed now so they can be tested end to end. Their buttons appear in the stage UIs as
those modules land, and on the order detail page meanwhile.

### Schema additions (approved with this spec)

One migration adds two columns; the hand-written constraints at the end of the init migration are untouched.

- `Settings.claimExpiryMinutes Int @default(30)` (integer 5–480). Added to `AdminSettings`, `PublicSettings`, the
  update contract and the General section of `/settings`.
- `Product.physical Boolean @default(true)`. False for products that are sold but never handled on the floor
  (Rush Order). `store-sync` sets it from WooCommerce's `virtual` flag on import. The gates, the queue item count
  and later the pick list skip lines whose product isn't physical. Lines without a product row count as physical.

### UI (`apps/web/src/app/(app)/`)

- **Nav:** Pending, Picking, Packing, QA, Ready, On Hold (each with a live count), All Orders, and Priority rules
  (`settings.manage` only).
- **`queue/[stage]`:** search box, table with order number, customer, items, priority badge, order date, time in
  stage (red past SLA), claim holder, external-change icon. Tablet-sized rows (NFR-UX-01). Row click → detail.
  Pending rows get a **Begin Picking** button.
- **`orders`:** All Orders with search, status filter, sortable columns, pagination (TanStack Table).
- **`orders/[id]`:** header (number, status, priority, customer, order date), claim banner ("Claimed by Ana
  12 min ago", Take over → confirmation dialog), action buttons from `allowedActions` (Begin Picking, Complete
  stage, Hold → reason dialog, Resume, Cancel → reason dialog, Force status → status + reason dialog), the
  unmet-gate list when a completion is refused, read-only lines, history panel.
- **`settings/priority-rules`:** list, add/edit dialog (type, fields, level), enable toggle, reorder, delete with
  confirmation.
- React Aria + daisyUI primitives, all strings in `en` and `es`, toasts for results (NFR-UX-04).

### Dev data

`pnpm db:seed` gains a dev-only `seedDemoOrders` (skipped when `NODE_ENV=production`): about 30 orders across all
statuses, including a Rush Order line (non-physical product), an Express shipping method and old orders. A matching rule set gives the
queues meaningful priority before `store-sync` exists. Tests use their own factories in `packages/core/test`.

### Files expected to change

`packages/core/src/workflow/{machine,gates,service,claims,priority,queries,notify}.ts` (+ tests),
`packages/core/src/{index,jobs}.ts`, `packages/core/src/settings/service.ts`, `packages/core/test/factories.ts`,
`packages/contracts/src/{orders,priority-rules,settings,index}.ts`, `apps/web/src/server/router.ts`,
`apps/web/src/app/api/events/orders/route.ts`, `apps/web/src/lib/live.ts`, `apps/web/src/app/(app)/{layout.tsx,
queue/**,orders/**,settings/priority-rules/**,settings/**}`, `apps/worker/src/main.ts`,
`packages/db/prisma/schema/{system,catalog}.prisma` + one migration, `packages/db/prisma/seed.ts`,
`packages/i18n/src/messages/{en,es}.json`, `apps/web/e2e/workflow.spec.ts`.

## Success criteria

1. **Machine:** every (from, to, kind) combination is tested. Listed ones pass, everything else fails with
   `errors.workflow.illegalTransition`. Nothing leaves COMPLETED or CANCELLED except via `forceStatus`.
2. **Gates:** each gate has a passing case and one failing case per unmet condition, and each unmet condition is
   reported with its own message key. Voided quantity is excluded. An over-packed line fails **packed**.
3. **Server-side enforcement:** calling `completePacking`, `completeQa` or `ship` directly through `/api/v1` on an
   order that doesn't meet the gate is refused and leaves the order, version and events unchanged (§7.1 #7).
4. **Permissions:** each procedure has an allowed and a forbidden test per role, e.g. a Picker can't
   `completePacking`, only Admin can `cancel`/`forceStatus`, and only `settings.manage` can edit rules.
5. **Optimistic locking:** two concurrent transitions with the same `expectedVersion` result in exactly one success
   and one `errors.workflow.stale`, tested with real concurrent transactions.
6. **Claims:** a second user's `claim` fails with the holder's name. `takeOver` without `confirm: true` fails.
   An expired claim is shown as free and can be claimed without takeover. `claimMany` with one conflicting order
   claims none. Advancing without holding the claim fails. A transition clears the claim, except
   `beginPicking`, which sets it.
7. **Hold:** hold from each stage, then resume, returns to that stage. Hold requires a reason. A held order
   appears only in the On Hold queue. Cancel/repack with a live label is refused.
8. **History and audit:** every transition writes exactly one stage event and one audit event with actor, station,
   from, to and reason. Claims and takeovers write audit events only. The history read returns them in order.
9. **Non-physical lines:** an order with an unpicked Rush Order line passes **picked**, **packed** and
   **verified** once its physical lines do, and the Rush Order line isn't counted in the queue's item count.
10. **Priority:** the evaluator is unit-tested per condition type, and the highest matching rule wins. Editing a
   rule recomputes open orders in the same transaction. The job raises an order that crossed an age threshold.
   A Rush Order line puts the order at Urgent.
11. **Queues:** sorted by priority then age. Search by number prefix and customer works on the server. Stage age
    and SLA breach use `stageSlaMinutes`. With 2,000 open seeded orders, `orders.queue` takes under 1 s p95 in an
    integration benchmark (NFR-PERF-01).
12. **Live:** a transition produces an SSE event to a subscribed client within 2 s. Unauthenticated subscribers
    are refused. Events carry no PII.
13. **E2E (desktop + tablet):** a picker begins picking a Pending order and sees it leave the Pending queue.
    A second browser sees the claim and takes over after confirming. Hold → On Hold queue → resume. An admin
    cancels. A completion refused by a gate shows the unmet list. A queue in one browser updates when another
    browser moves an order, without reloading.
14. Green: `pnpm lint && pnpm typecheck && pnpm test && pnpm build` plus Playwright.

## Implementation notes (deviations found while building)

- **Lock order:** every claim and transition reads Settings before it locks the order, and a priority recompute
  locks the orders it changes in id order (as `claimMany` does). Mixed orders deadlocked under real concurrency.
  `loadSettings` creates the row with `INSERT … ON CONFLICT DO NOTHING`: Prisma's upsert failed two first
  uses at once with a duplicate key.
- **Voids and priority:** a fully voided line doesn't match `lineItem` rules. Voids don't trigger a recompute on
  their own: `exceptions` must call `recomputePriorities(tx, { orderIds })` when it voids or un-voids a line.
- **verified** also needs at least one package (`noPackages`). Without that, "every package is verified" held for
  an order with none, so it could reach Ready and then fail **shippable**. Found by the SC 3 e2e test.
- `beginPicking` over someone else's live claim is refused with `claimedByOther`, the same as `claim`. The UI
  doesn't offer it (`allowedActions`).
- People are shown by name, or by email when the name is empty (magic-link users start without one):
  `workflow/people.ts` `displayName`, used for claim holders, conflict errors and history.
- Recomputes run one at a time (a transaction-scoped advisory lock). Otherwise the 5-minute job could write
  priorities from rules an admin had just changed, and two recomputes could deadlock on the same orders.
- `recomputePriorities` also covers held orders (every status that isn't closed). Reordering rules doesn't
  recompute, because `position` doesn't affect priority.
- `ship` and `repack` take the caller's `tx` and have no route yet. `shipping` will route them; their gates are
  tested in core.
- SC 11 benchmark (`queries.bench.test.ts`): 2,000 open orders (80% Pending, 3 lines each, with voids, non-physical
  lines and claims). `listQueue` p95 is about 10–20 ms on the dev machine for the first page, a 100-row page, a deep
  keyset page and both kinds of search. The existing `(status, priority desc, ordered_at)` index is enough, so no
  `pg_trgm` index was needed.

## Assumptions

1. Priority has three levels (Normal / High / Urgent), stored as 0–2 in the existing `Order.priority`.
2. Claim expiry defaults to 30 minutes and is refreshed by the holder's activity on that order.
3. Ship and repack don't require a claim. Shipping works on batches of Ready orders, and repack is a correction.
4. Admins follow the same claim rules as everyone else (they take over with confirmation); only `forceStatus`
   bypasses gates.
5. "Item count" in queues is the total active units of physical lines, not the number of lines.

## Decisions (resolved open questions, 2026-10-15)

1. **Rush Order** is a product line item in WooCommerce. It drives priority (Urgent, via a `lineItem` rule) and is
   ignored when physically picking, packing and shipping (`Product.physical = false`).
2. **Customer-tag priority** is deferred until `store-sync` shows where tags come from.
3. The five assumptions above are confirmed.

## Open questions

1. Is the Rush Order product marked **Virtual** in WooCommerce? If it is, `store-sync` derives `physical = false`
   automatically. If not, the simplest fix is to tick Virtual on it in the store (Woo then also skips shipping for
   it); otherwise we need an admin override. To check when `store-sync` pulls real products.
