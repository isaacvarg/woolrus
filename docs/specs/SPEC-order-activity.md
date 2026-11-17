# Spec: `order-activity`

**Milestone:** M5 · **Depends on:** `workflow` (stage events, claims, the History tab), `identity` (roles,
stations), `settings`, and the modules whose actions it shows: `picking`, `packing`, `lumexia`, `exceptions`,
`notes`, `carriers`, `qa`, `shipping`, `store-sync` · **Used by:** `reporting` (audit rows by order, blocked scans)
· **State:** in progress (spec approved 2026-11-17; tickets #197–#207) · **Issue:** [#196](https://github.com/isaacvarg/woolrus/issues/196)

Project-wide commands, structure, code style, testing levels and boundaries are in [`../../SPEC.md`](../../SPEC.md);
this spec only adds what is specific to `order-activity`.

## Objective

Show everything that happened to an order in one place. Today the History tab shows only status changes and
claims, although nearly every action on an order is already written to `AuditEvent`. This module replaces the
History tab with an activity view: a summary of time and people per stage at the top, then a full timeline of
picks, packing, scans, rates, labels, notes, issues, voids, store changes and status changes.

It also starts saving the wrong scans that picking, packing and QA refuse, which today leave no record. They are
the clearest sign of a near-miss, and the warehouse manager review asked for them.

- **SRS:** FR-WF-05/08 (history and audit), FR-WF-04 (who and when per item). Groundwork for FR-REP-\* cycle time
  and FR-QI-07 (quality dashboard), which stay in `reporting`.
- **Users:** everyone who can open an order. An Admin chooses, per role, which parts of the view each role sees.
- **Background:** the review shared with the warehouse manager ("Woolrus Activity Tracking Review", 2026-11-17)
  lists what is recorded today and the gaps this module closes.

### User stories

1. As a supervisor, I open an order's **History** tab and see, at the top, how long it spent in Picking, Packing
   and QA, how much of that was waiting before anyone started, and who worked each stage.
2. Below that I scroll a timeline, newest first: "Maria packed 6 × Lavender soap 8 oz into Box 1 · Packing
   station 2 · 10:42". Twelve scans in a row read as one entry I can expand.
3. I filter the timeline to **Problems** and see that QA scanned the wrong jar twice before verifying, the issue
   Maria reported, and the void an admin resolved.
4. As a packer in the pack drawer, I open History and see the same view, so I know who picked the order and what
   QA flagged last time.
5. As an Admin, I open **Settings → Activity** and turn off per-person times for Pickers and Packers. They still
   see the timeline; the people section disappears for them and the server stops sending it.
6. As an Admin, I expand an entry and see what changed: weight 2 lb 4 oz → 2 lb 9 oz, with the overweight reason.

## Scope

**In:**
- `AuditEvent.orderId`: a new column set on every audit row about an order or something inside it, backfilled for
  existing rows, plus a check that order-scoped rows always carry it.
- `ScanMiss`: a new table for scans that picking, packing and QA refuse, written after the refusal.
- An action registry in core: every order-scoped audit action, its category and its message key, with `en` and
  `es` strings for each.
- The activity read: stage summary, people per stage, and the timeline (merged stage events, audit rows and scan
  misses, grouped and filtered), trimmed to what the viewer's roles may see.
- A role-based visibility setting and its admin UI.
- UI: the History tab of the order page replaced by the activity view; the same view in the pack and QA drawers.
- Consistency fixes the feed needs: audit `entityType` values `"order"` and `"manifest"` become `"Order"` and
  `"Manifest"`.

**Out (owned elsewhere or later):**
- Reports across orders (items picked per person, time per stage over a week, mistakes per person): `reporting`.
  This module stores what those reports need but builds no report.
- Counting mistakes or blaming anyone. The feed shows blocked scans and issues as they happened; which ones count
  as a person's mistake is a `reporting` decision.
- A warehouse-wide audit log browser for admins (users, settings, stations). Not planned yet.
- New "waiting to pack" or "waiting for QA" statuses. Waiting time is derived from the first action in a stage.
- Showing note text in the timeline. Entries link to the Notes tab, which already applies note rules.
- Rate quotes and label prints as their own entries beyond the audit rows that already exist (`rates.refresh`,
  `label.print`). The quote log stays in `rate-history`.

## Design

### Order on audit rows (`packages/core/src/audit.ts`)

`recordAudit` gains `orderId?: string`. Every call about an order, or about a line, package, package item, label,
note, issue, void, check trip or approval that belongs to one, passes it. Pick batches and product barcode links
pass it when the call has a single order in hand (one row per order for batch operations that touch several).

A guard in `recordAudit` throws in development and test when the entity type is order-scoped
(`Order`, `OrderItem`, `Package`, `PackageItem`, `PackageCheckTrip`, `ShippingLabel`, `Note`, `QualityIssue`,
`ItemVoid`) and `orderId` is missing. Production logs a warning instead of failing the user's action.

**Backfill** (in the migration), first match wins:

| Entity type | Order from |
|---|---|
| `Order`, `order` | `entity_id` |
| `OrderItem`, `ItemVoid`, `QualityIssue`, `Note` | that row's `order_id` |
| `Package`, `PackageCheckTrip`, `PackageItem`, `ShippingLabel` | through the package's `order_id` |
| `Approval` | the guarded entity in `after` (`entityType`, `entityId`), resolved as above |
| Rows whose entity was deleted | `orderId` in `before` or `after`, when present |

Rows that still have no order stay null and never show in a feed. The same migration rewrites
`entity_type = 'order'` to `'Order'` and `'manifest'` to `'Manifest'`, and the three call sites change to match.

### Blocked scans (`ScanMiss`)

A scan refused by `picking.scan`, `pickBatches.scan`, `packing.scanIntoPackage` or `qa.scan` rolls back, so the
service writes the miss in its own short transaction after the refusal and then rethrows the same error. The
refusal the user sees doesn't change.

| Field | Meaning |
|---|---|
| `orderId` | The order scanned against. For a batch scan with no matching order: the batch's first order, with `batchId` set |
| `stage` | `PICKING`, `PACKING` or `QA` |
| `kind` | `NOT_ON_ORDER` (a known product that isn't on the order), `UNKNOWN_CODE`, `ALREADY_DONE` (line already picked, packed or verified), `OTHER_PACKAGE` (QA, item is in another box) |
| `code` | The normalized code scanned |
| `productName` | The product the code belongs to, when known |
| `orderItemId`, `packageId`, `batchId` | When the refusal named them |
| `actorId`, `stationId`, `at` | Who, where, when |
| `scanId` | The client's scan id; unique, so a retried request records one miss |

`UNKNOWN_CODE` is recorded too: it can be a barcode nobody linked yet rather than a mistake, and the timeline says
so. Refusals that aren't about the item scanned (claim lost, purchase in progress, batch closed) are not misses.

### Action registry (`packages/core/src/activity/actions.ts`, pure)

One `const` object lists every order-scoped audit action: its **category** and whether **consecutive repeats
group**. `recordAudit`'s `action` is typed so an order-scoped call must use a registry key.

Categories (the timeline filters): **Status** (stage events, hold, cancel, force, claims), **Picking** (picks,
batches, barcode links), **Packing** (packages, units, weights, box scans, lots at packing), **QA** (scans,
verify, box confirm, check acknowledgements, approvals, lot replacement), **Shipping** (rates, ship-to, labels,
prints, Woo push), **Problems** (voids, issues, scan misses), **Notes**, **Store** (import, store changes, PII
removal).

Each action has an `activity.action.<action>` message in `en` and `es`; a test fails when one is missing. The
server returns the action key and its parameters (line name, quantity, box number, label carrier); the web app
renders the words. An action the registry doesn't know renders as a generic "Changed <entity>" line, so an old
row never breaks the page.

### Timeline (`packages/core/src/activity/timeline.ts`)

`getOrderActivity(db, actor, { id })` reads, for one order: stage events, audit rows with that `orderId`, and scan
misses. They are merged newest first, each with time, category, action, actor (or the system actor's name),
station, a **target** label (line name, "Box 2", label carrier and tracking ending) and message parameters.

**Grouping:** consecutive entries by the same person, with the same action and target, less than 5 minutes apart,
become one entry with a count and a time range ("Scanned 12 items into Box 1, 10:31–10:38"). The entry expands
to its members. Status changes, issues, voids, scan misses, approvals and label purchases never group.

**Details:** each entry carries the audit row's `before` and `after`, cleaned of secrets and customer details
(the logger's PII and secret key lists, `isPiiKey` in `@woolrus/logger`) and of internal ids and version numbers.

The read returns at most 2,000 rows (an order with more is not expected). If it is cut, the response says so.

### Stage summary (`packages/core/src/activity/summary.ts`, pure)

Built from stage events and the timeline's entries:

1. **Intervals.** Each stay in a status is an interval, from the event that entered it to the one that left it
   (or now). A repack makes a second Packing interval; holds are their own intervals and count in no stage.
2. **Status time** per stage = the sum of its intervals.
3. **First action** in an interval = the earliest entry by a person (not the system) in that interval.
   **Waiting** = interval start → first action. **Working** = first action → interval end. Picking starts with
   the person's own `beginPicking`, so its waiting time is normally zero.
4. **People** per stage: each person with entries in its intervals, with their entry count, first and last
   action, and their span (first → last).
5. **Pending** and **Ready** show status time only: they are queues, not work.
6. **Batch picking:** a pick interval whose `beginPicking` came from a batch says "Picked in batch N with M
   orders"; its times are this order's own picks, which overlap the other orders in the batch.

No idle cutoff: working time and spans include breaks. See open question 1.

### Visibility (`Settings.activityVisibility`)

A JSON setting: for each role, which of four parts it sees.

| Part | What it covers |
|---|---|
| `timeline` | The timeline entries (with names, stations, times) |
| `details` | The before/after values when an entry is expanded |
| `summary` | Status, waiting and working time per stage |
| `people` | Who worked each stage and their spans |

Default: every part on for every role, which matches "everyone sees everything". Admins always see every part.
A person with several roles sees a part if any of their roles does. The server leaves hidden parts out of the
response, so a hidden part can't be read through the API. If a viewer sees no part, the History tab is hidden.

Changing it needs `settings.manage` and is audited like other settings changes.

### API (oRPC, `packages/contracts/src/orders.ts`, `settings.ts`)

| Procedure | Route |
|---|---|
| `orders.activity` | `GET /orders/{id}/activity` |
| `settings.get` / `settings.update` | existing; gain `activityVisibility` |

`orders.activity` returns `{ visible, summary?, people?, entries?, truncated }`; parts the viewer can't see are
absent. It replaces `orders.history`, which is removed with its `OrderHistoryEntry` type once the UI is moved.

### Schema additions (approved with this spec)

One migration, including the backfill and the `entity_type` rewrite. The hand-written constraints at the end of
the init migration are untouched.

```prisma
model AuditEvent {
  // existing fields…
  orderId String? @map("order_id") @db.Uuid   // no FK: rows outlive their order's PII purge unchanged

  @@index([orderId, at])
}

enum ScanMissStage { PICKING PACKING QA  @@map("scan_miss_stage") }
enum ScanMissKind  { NOT_ON_ORDER UNKNOWN_CODE ALREADY_DONE OTHER_PACKAGE  @@map("scan_miss_kind") }

model ScanMiss {
  id          String        @id @default(uuid(7)) @db.Uuid
  orderId     String        @map("order_id") @db.Uuid
  stage       ScanMissStage
  kind        ScanMissKind
  code        String
  productName String?       @map("product_name")
  orderItemId String?       @map("order_item_id") @db.Uuid
  packageId   String?       @map("package_id") @db.Uuid
  batchId     String?       @map("batch_id") @db.Uuid
  actorId     String?       @map("actor_id") @db.Uuid
  stationId   String?       @map("station_id") @db.Uuid
  scanId      String?       @unique @map("scan_id")
  at          DateTime      @default(now()) @db.Timestamptz(3)

  order   Order    @relation(fields: [orderId], references: [id], onDelete: Cascade)
  actor   User?    @relation(fields: [actorId], references: [id], onDelete: SetNull)
  station Station? @relation(fields: [stationId], references: [id], onDelete: SetNull)

  @@index([orderId, at])
  @@index([actorId, at])
  @@map("scan_misses")
}

// Settings
activityVisibility Json @default("{}") @map("activity_visibility")  // missing role/part = on
```

### UI (`apps/web/src/app/(app)/`)

- **`orders/[id]/activity-panel.tsx`** replaces `history-panel.tsx` in the order page's **History** tab (the tab
  keeps its name and `?tab=history` URL), the pack drawer and the QA drawer.
- **Summary** at the top: one row per stage (Pending, Picking, Packing, QA, Ready) with status time and, for the
  three work stages, a bar split into waiting and working, and the people who worked it. A repacked order shows
  each Packing interval. Times use the existing duration formatting.
- **Timeline** below: category filter chips with counts, then entries newest first. Each shows the message, who,
  station and time; grouped entries show the count and range and expand. Scan misses and problems are marked
  with the error colour. An entry with details expands to a before → after list. Note entries link to the Notes
  tab.
- **Live:** the panel refetches on the order's existing `order_changed` event.
- **Settings → Activity:** a table of roles × the four parts, with switches.
- Works on a tablet at floor-station width and with the station's large touch targets; strings in `en` and `es`.

### Dev data

The seed's orders get realistic activity: picks, a batch, packing with a reweigh, two QA scan misses, a repack
and an issue, so the panel and summary have something to show.

### Files expected to change

`packages/core/src/audit.ts`, `packages/core/src/activity/{actions,timeline,summary,visibility}.ts` (+ tests),
every `recordAudit` call site with an order in hand (`picking`, `packing`, `lumexia`, `qa`, `shipping`,
`carriers/{rates,ship-to}`, `exceptions`, `notes`, `sync`, `workflow`, `operations/anonymize`, `identity/approvals`),
`packages/core/src/{picking/scan,picking/batch-scan,packing/service,qa/scan}.ts` (scan misses),
`packages/core/src/workflow/queries.ts` (history read removed), `packages/core/src/settings/service.ts`,
`packages/core/test/factories.ts`, `packages/contracts/src/{orders,settings}.ts`, `apps/web/src/server/router.ts`,
`apps/web/src/lib/live.ts`, `apps/web/src/app/(app)/orders/[id]/{activity-panel,order-view}.tsx` (history panel
removed), `apps/web/src/app/(app)/{pack/[orderId]/order-drawer,qa/[orderId]/qa-drawer}.tsx`,
`apps/web/src/app/(app)/settings/**`, `packages/db/prisma/schema/{system,orders}.prisma` + one migration,
`packages/db/prisma/seed-orders.ts`, `packages/i18n/src/messages/{en,es}.json`, `apps/web/e2e/order-activity.spec.ts`.

## Success criteria

1. **Order on audit rows:** every order-scoped `recordAudit` call passes `orderId`; the guard throws in test when
   one doesn't, and a test runs one action of each category and finds its row by `orderId`.
2. **Backfill:** a migration test seeds rows of each entity type (including a deleted package and a label) with no
   `orderId`, migrates, and finds each mapped as in the table; unmappable rows stay null. No `entity_type` of
   `order` or `manifest` remains.
3. **Scan misses:** each of the four scan procedures, refused for each `kind` that applies, writes one `ScanMiss`
   with the right fields and returns the same error as before; a replay with the same `scanId` writes no second
   row; a refusal not about the item (claim lost, purchase in progress) writes none.
4. **Registry:** every action `recordAudit` is called with for an order-scoped entity is a registry key (type
   check), and every key has `en` and `es` messages (test). An unknown action renders the generic line.
5. **Timeline:** merges the three sources newest first; groups same person + action + target within 5 minutes and
   never groups the listed kinds; filters by category; details are scrubbed of secrets, customer details, ids and
   versions; a 2,001-row order returns 2,000 and `truncated: true`.
6. **Summary:** pure tests cover a straight run, a repack (two Packing intervals), a hold in the middle (excluded),
   an order still in QA (interval runs to now), a batch pick, and a stage with two people. Waiting + working equals
   status time for each work interval.
7. **Visibility:** with defaults every role gets every part; switching a part off for a role removes it from that
   role's response (API test, not only UI); a person holding a role with it on still gets it; Admins always get
   everything; a viewer with no parts gets no History tab. Updating needs `settings.manage` and is audited.
8. **UI:** the History tab, pack drawer and QA drawer show the activity panel; `orders.history` and the old panel
   are gone; filters, grouping, expansion and live refresh work. One Playwright test walks an order through
   pick (with a wrong scan), pack and QA and checks the summary, the miss in **Problems**, and a role with
   `people` off.
9. **Performance:** `orders.activity` for an order with 500 audit rows answers in under 300 ms on the dev stack.

## Assumptions

1. A typical order has under 200 audit rows; a big one under 1,000. The 2,000-row cap is a safety net.
2. Stage events are the source of truth for status time. Audit rows are only used for first and last actions.
3. The backfill runs inside the migration; the audit table is small enough (well under a million rows) that one
   pass of updates with joins is fine.
4. Showing names, stations and times to every role is acceptable by default, as today's History tab already does.
   The visibility setting is how a warehouse narrows it.
5. Blocked scans are worth recording even when they aren't mistakes (an unlinked barcode, a double scan). The
   `kind` lets `reporting` decide what counts.

## Decisions (2026-11-17)

1. **A module of its own,** not a `workflow` amendment: the feed reads every floor module's actions, and
   `workflow` must not depend on packing, QA or shipping.
2. **Blocked scans are in scope** and get their own table, so reports can count them without parsing audit JSON.
3. **Summary at the top of the History tab:** status, waiting and working time per stage, and who worked it,
   then the timeline.
4. **Everyone sees everything by default; an Admin can narrow it per role,** for four parts: timeline, details,
   summary, people. Hidden parts are never sent.
5. **The History tab is replaced,** not joined by a second tab. It keeps its name and URL.

## Open questions

1. **Idle cutoff.** Should working time skip pauses longer than some limit (5 or 10 minutes)? Asked in the
   warehouse manager review; until answered, spans include pauses and the UI labels them "first to last action".
2. **Batch time.** Split a batch's picking time across its orders (evenly, or by items), or keep each order's own
   pick times as now? Also asked in the review; affects `reporting` more than this view.
3. **Station-only users.** They hold floor roles; confirm the same per-role visibility applies to them.
