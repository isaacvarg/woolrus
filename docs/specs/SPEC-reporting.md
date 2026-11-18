# Spec: `reporting`

**Milestone:** M5 · **Depends on:** `shipping` (shipped orders, labels), `exceptions` (issues, voids),
`order-activity` (stage intervals, scan misses), `workflow` (stage events, SLA thresholds), `rate-lab` (Real orders
read, reused for spend), `identity` (the new role) · **Used by:** — · **State:** planned (spec approved 2026-11-18; tickets #209–#218) ·
**Issue:**
[#32](https://github.com/isaacvarg/woolrus/issues/32)

Project-wide commands, structure, code style, testing levels and boundaries are in [`../../SPEC.md`](../../SPEC.md);
this spec only adds what is specific to `reporting`.

## Objective

Let an admin see how the warehouse is doing over days and weeks, not one order at a time: how much each person and
stage gets through, how long orders take, where mistakes happen, and what shipping costs. Then let them take any of
it, or any list, out as CSV.

Most of the data is already stored. `order-activity` added the order id on audit rows, blocked scans and the stage
interval logic, and `rate-lab` already answers "what did shipping cost" on its Real orders page. This module adds
the cross-order reads, a Reports area, SLA alerts on the home dashboard, and CSV exports for the lists that don't
have one.

- **SRS:** FR-REP-01 (throughput), FR-REP-02 (cycle time), FR-REP-03 (spend, see below), FR-REP-04 (CSV for every
  list and report), FR-QI-07 (quality dashboard), SRS §7.1 #17 (home page with queue counts and SLA alerts).
- **Users:** Admins, and floor leads given the new **Reports** role (`REPORTS`, granting `report.read`). Every
  signed-in user still gets the home dashboard.
- **What's already built:** the home dashboard (queue tiles, open issues, orders per day, queue buttons), the CSV
  writer `packages/core/src/csv.ts`, CSV routes for lots and Rate Lab, and Rate Lab → Real orders (spend by carrier
  and service, label cost vs. charged, its own CSV).

### User stories

1. As an admin, I open **Reports → Throughput** for last week and see, per day, how many orders and units each
   person picked, packed, QA'd and shipped. I switch to "by person" and see Maria packed 412 units across 5 days.
2. As an admin, **Reports → Cycle time** shows that orders shipped in the last 30 days took a median of 6 h 10 m from
   import to shipped (p90 1 d 4 h), and that most of it is waiting in Pending, not working in Packing.
3. As an admin, **Reports → Quality** shows issue counts per week by type, by the stage that found them, by the
   stage they came from and by responsible person, with blocked scans by stage and kind next to them.
4. As an admin, **Reports → Spend** takes me to the Real orders page I already know, with the same date range.
5. As an admin, on the **All orders** list filtered to "Completed, last 7 days", I press **Export CSV** and get
   the rows I'm looking at. The same button is on Issues, Voids and every report.
6. As a packer on the floor tablet, the home dashboard tells me 3 orders in Packing are past their SLA, and tapping
   it opens the Packing queue.

## Scope

**In:**
- Core reads (`packages/core/src/reporting/`): throughput, cycle time, quality. Aggregated in Postgres, bucketed
  by day in the viewer's time zone.
- A **Reports** area (`/reports`) with Throughput, Cycle time, Quality and Spend tabs; shared date range and filters;
  charts plus an accessible table for each (the `ChartFigure` pattern the dashboard uses).
- CSV routes for each report and for the **All orders**, **Issues** and **Voids** lists, with the list's current
  filters.
- Home dashboard: an SLA alert (orders past their stage's SLA, per stage, linking to the queue). For `report.read`
  holders, a "Shipped today" tile and the 7-day median cycle time.
- Indexes the reads need (below).
- A **Reports** role (`REPORTS`), ticked on a user next to their floor roles, like `RATE_LAB`. It grants only
  `report.read` on top of the everyone set, so a floor lead sees Reports, Real orders and the exports without
  being able to manage users, settings or credentials.
- An idle cutoff for working time, shared with the History tab (below).

**Out (owned elsewhere or later):**
- A second spend report. FR-REP-03 is delivered by `rate-lab` (Real orders); the Spend tab links to it. See
  Decision 1.
- Scheduled or emailed reports, saved report views, PDF of the new reports.
- Per-person targets, rankings or scores. Reports show counts and rates as they happened; they don't rank people.
- Returns metrics (`returns` isn't built).
- A warehouse-wide audit log browser (still not planned).
- Splitting a batch's picking time across its orders. Each order keeps its own pick times, as in `order-activity`
  (its open question 2).

## Design

### Shared input (`packages/contracts/src/reports.ts`)

```ts
export const ReportRange = z.object({
  from: IsoDate,                 // YYYY-MM-DD, inclusive, in timeZone
  to: IsoDate,                   // inclusive; at most 92 days after from
  timeZone: TimeZone,            // the viewer's IANA zone, as orders.dailyActivity takes it
});
```

Presets in the UI: Today, Last 7 days (default), Last 30 days, Last 90 days, Custom. Days are bucketed with
`date_trunc('day', at AT TIME ZONE $tz)`, the same way `orders.dailyActivity` does it.

### Throughput (FR-REP-01, `reporting/throughput.ts`)

For each day × stage × person: **orders** and **units**.

| Stage | Orders (credited to) | Units (credited to) |
|---|---|---|
| Picking | stage events `PICKING → PACKING` (actor) | `OrderItem.pickedQuantity` by `pickedById` on `pickedAt` |
| Packing | stage events `PACKING → QA` (actor) | units each `package.packUnits` / `packRemaining` / `scan` / `unpackUnits` audit row added (after − before), by its actor |
| QA | stage events `QA → READY` (actor) | verified units each `packageItem.scan` / `verify` / `unverify` audit row added (after − before), by its actor |
| Shipping | stage events `READY → COMPLETED` (actor) | units on the order's live packages |

Plus a warehouse row per day: orders imported (stage events with no `fromStatus`) and orders shipped.

- A repack sends an order through Packing and QA again. Each pass counts: the work happened. Package items of a
  discarded package still count for the person who packed them.
- Packing and QA units come from the audit trail, because a box line keeps only its latest packer and verifier and a
  repack clears QA. Two packers on one line each get their own units. Taking units out or unverifying takes them
  back from whoever does it; deleting a package or a void trimming a box takes nothing back.
- Voided units are left out of picking units (and so of what ships); a unit voided after it was boxed or verified still
  counts for that packer or verifier. An order fully voided and cancelled never reaches a `→ COMPLETED` event.
- Events by the system actor (no `actorId`) count in the warehouse totals and under "System" in the per-person
  rows.
- Views: **by day** (stacked bars per stage) and **by person** (table: person × stage, orders and units for the
  range, plus active days). Filters: stage, person.

### Cycle time (FR-REP-02, `reporting/cycle-time.ts`)

Cohort: orders whose `→ COMPLETED` stage event falls in the range.

- **Import → shipped:** first stage event (import) to the `→ COMPLETED` event. Hold intervals are included in this
  figure and also reported separately ("of which on hold").
- **Per stage:** status time per stage, built with the interval rules in `order-activity`'s
  `activity/summary.ts` (holds count in no stage; a repack adds a second Packing interval, summed). For Picking,
  Packing and QA, also waiting (interval start → first action) and working (first action → interval end).
- **Figures:** count, median, p90 and mean for each; computed in TypeScript over the cohort's summary records
  (`activity/summary-items.ts`: stage events, visible audit rows and blocked scans, the History tab's sources),
  since the interval rules live there. They're read with one raw query per 2,000 orders, the batches side by side:
  through `findMany`, mapping the rows took most of a 10,000-order read. Expected cohort: a few thousand orders
  for 90 days.
- **By day:** median import → shipped per shipping day (line chart), so a slow week stands out.
- **Slowest orders:** the 20 longest import → shipped in the cohort, each linking to the order's History tab.
- Orders that are still open aren't in the cohort. The home dashboard's SLA alert covers those.

`summary.ts` exports a pure `stageIntervals(items, now)`, taking an order's activity items (every action, not
just the first, since idle needs each gap); the History tab keeps using the same function, so the two can't
disagree.

**Idle cutoff** (answers `order-activity` open question 1): a gap of more than **10 minutes** between two
consecutive actions by people in a work interval is not working time. It moves to a third bucket, **idle**, so
waiting + working + idle = status time. The rule lives in `summary.ts`, so the History tab's summary, its people
spans and this report all change together; the History tab labels working time "working (pauses over 10 min
left out)". The 10 minutes is a constant in `activity/summary.ts`, not a setting; it can become one if the floor
asks.

### Quality (FR-QI-07, `reporting/quality.ts`)

Issues created in the range, bucketed by **week** (Monday start, in the viewer's zone) or by day for ranges of 14
days or fewer.

- Counts by **type**, by **discovered stage**, by **origin stage** and by **responsible person**, each over time
  (stacked bars) and as a total table.
- Filters: severity, customer-reported only, status (open / resolved / all).
- **Rate per person:** issues where they're responsible ÷ units they handled in that stage (from Throughput), per
  1,000 units. Shown only when they handled at least 100 units in the range, so a 2-unit day doesn't read as a 50%
  error rate. See open question 2.
- **Blocked scans** (from `ScanMiss`): counts by stage and kind, by person. `UNKNOWN_CODE` is shown in its own
  column labelled "Unknown barcode", apart from the others, since it's often a barcode nobody linked yet rather than
  a mistake.
- **Voids:** count by stage and resolution for the range.

### Spend (FR-REP-03)

No new read. The Spend tab is a link card to **Rate Lab → Real orders** with `?from&to` from the shared range, and
the Real orders page reads those params. Real orders already needs `report.read`.

### Home dashboard (SRS §7.1 #17)

- **SLA alert:** a strip above the tiles, shown only when at least one order is past its stage SLA: "3 in Packing
  and 1 in QA past SLA". Each count links to its queue filtered to late orders. It uses `queueCounts`, extended to
  return `late` per stage with the same rule `listQueue` uses for `slaBreached` (time in stage > the stage's
  `stageSlaMinutes`). Refreshes on the existing order events.
- **For `report.read` holders only:** a "Shipped today" tile and "Median cycle time, last 7 days" tile linking to
  Reports. Others see the dashboard as it is now.

### CSV exports (FR-REP-04)

Route Handlers using `csvStream`, session-checked like `api/lots/export.csv`. Each takes the same query params as
the screen it sits on, so the file matches what's shown. Filenames: `woolrus-<report>-<from>-<to>.csv`.

| Route | Rows | Permission |
|---|---|---|
| `GET /api/reports/throughput.csv` | day, stage, person, orders, units | `report.read` |
| `GET /api/reports/cycle-time.csv` | one per order in the cohort: number, imported, shipped, total, on hold, per-stage status/waiting/working minutes | `report.read` |
| `GET /api/reports/quality.csv` | one per issue: number, created, type, severity, status, discovered, origin, responsible, customer-reported, resolved at | `report.read` |
| `GET /api/reports/scan-misses.csv` | one per blocked scan: order number, at, stage, kind, code, product, person, station | `report.read` |
| `GET /api/orders/export.csv` | the All orders list with its filters: number, ordered, imported, status, priority, customer name, items, units, shipped at, tracking | `report.read` |
| `GET /api/issues/export.csv` | the Issues list with its filters | `report.read` |
| `GET /api/voids/export.csv` | the Voids list with its filters | `report.read` |
| `GET /api/reports/order-items.csv` | one per order line on orders imported in the range: order number, SKU, product, ordered qty, picked qty, pick status, picked by/at, packed by/at, QA by/at, voided qty | `report.read` |
| `GET /api/users/export.csv` | one per user: name, email, roles, active, station-only, created; plus, for the range, orders and units per stage, issues responsible for, blocked scans | `report.read` |

- Exports carry no customer addresses, emails or phone numbers. (The users export has staff emails.) An order whose PII was purged exports its number and an
  empty customer name.
- Durations are whole minutes; times are ISO 8601 in the requested zone; headers come from `en`/`es` per the
  viewer's locale.
- Capped at 100,000 rows; a longer export ends with a final row saying it was cut (and logs a warning).
- Queue lists don't get their own button: All orders filtered by status covers them.

### API (oRPC)

| Procedure | Route | Permission |
|---|---|---|
| `reports.throughput` | `GET /reports/throughput` | `report.read` |
| `reports.cycleTime` | `GET /reports/cycle-time` | `report.read` |
| `reports.quality` | `GET /reports/quality` | `report.read` |
| `orders.counts` | existing; gains `late` per stage | `order.read` |
| `reports.today` | `GET /reports/today` (shipped today, 7-day median) | `report.read` |

### Schema additions (approved with this spec)

Three migrations: `reports_role` (adds `REPORTS` to the `role` enum), `reporting_throughput_indexes` (order
items, package items, stage events) and `reporting_quality_indexes` (scan misses). No new tables or columns. The hand-written constraints at the end of the init
migration are untouched.

```prisma
enum Role { /* existing… */ REPORTS }   // Reports: read reports and exports (SPEC-reporting decision 5)

model OrderItem    { @@index([pickedAt]) }
model PackageItem  { @@index([packedAt]) @@index([qaVerifiedAt]) }
model ScanMiss     { @@index([at]) }
model OrderStageEvent { @@index([at]) }   // the import/shipped cohort scans; [toStatus, at] exists
```

### UI (`apps/web/src/app/(app)/reports/`)

- Sidebar **Reports** item for `report.read`. `layout.tsx` with tabs Throughput · Cycle time · Quality · Spend,
  and the range picker and **Export CSV** in a shared header. Range and filters live in the URL, so a link shares
  the view.
- Charts with Recharts and the existing chart theme (`components/charts/theme.ts`, `ChartFigure` with its table
  twin); colours are never the only cue.
- Durations use the existing duration formatting; numbers use `useFormatter`. Strings in `en` and `es`.
- **Export CSV** buttons added to All orders, Issues and Voids.
- Desktop first; usable on the tablet (tables scroll horizontally, no hover-only content).

### Dev data

`seedReportingHistory` (`packages/db/prisma/seed-reporting.ts`, run by `pnpm db:seed` after the demo orders)
adds 150 shipped orders spread over the last 30 days, a few shipped within the last hours so the home tiles show
today. They're picked, packed, checked and shipped by named demo people (two pickers, two packers, a QA checker
and a shipper; the carrier completes one order in 17, under System), with holds, a repack every 37 orders, a
20-minute pause on some picks (idle), an issue on one order in six cycling through every type (origins,
responsible people, open, resolved and dismissed, some customer-reported), a blocked scan on one in five
cycling through every kind and stage, and a few voids. Ids are in their own range (9,100,001+); re-running adds
nothing. The generator is deterministic, and the speed check (criterion 8) runs it at 10,000 orders over 90 days.

### Files expected to change

`packages/core/src/reporting/{throughput,cycle-time,quality,today,exports}.ts` (+ tests),
`packages/core/src/activity/summary.ts` (interval function, idle cutoff) and the History tab's summary
(`orders/[id]/activity-panel.tsx`), `packages/core/src/permissions.ts` (`REPORTS`), the users admin role
picker, `packages/db/prisma/schema/auth.prisma`,
`packages/core/src/workflow/queries.ts` (`queueCounts` gains `late`), `packages/contracts/src/{reports,orders}.ts`,
`apps/web/src/server/router.ts`, `apps/web/src/app/api/{reports,orders,issues,voids}/**/route.ts`,
`apps/web/src/app/(app)/reports/**`, `apps/web/src/app/(app)/{dashboard,drawer-nav}.tsx`,
`apps/web/src/app/(app)/{orders,issues,voids}/*` (export buttons),
`apps/web/src/app/(app)/rate-lab/real-orders/*` (read `from`/`to` params),
`packages/db/prisma/schema/{orders,shipping}.prisma` + their migrations, `packages/db/prisma/seed-reporting.ts`
(+ `seed.ts`), `packages/core/src/activity/summary-items.ts`, `packages/core/src/reporting/reporting.bench.test.ts`,
`packages/i18n/src/messages/{en,es}.json`, `apps/web/e2e/reports.spec.ts` and `apps/web/e2e/reports-journey.spec.ts`.

## Success criteria

1. **Throughput:** on seeded events and items, orders and units per day × stage × person are exact, including a
   repack (both passes count), a voided unit (excluded), a system-actor event (under System) and a day boundary in
   a non-UTC zone (an event at 23:30 local lands on that local day).
2. **Cycle time:** median, p90 and mean of import → shipped and of each stage's status, waiting and working time
   are exact on a seeded cohort; holds are excluded from stages and reported apart; a repack's two Packing
   intervals sum; an order still open is not in the cohort. A test proves the History tab summary and the report
   agree for the same order. Idle cutoff: a 25-minute gap between two actions puts 25 minutes in idle, a
   9-minute gap stays in working, and waiting + working + idle equals status time.
3. **Quality:** counts by type, discovered stage, origin stage and responsible person per week are exact; filters
   apply; the per-person rate appears only at ≥ 100 units; blocked scans split `UNKNOWN_CODE` from the rest; voids
   count by stage.
4. **Spend:** the Spend tab links to Real orders with the range, and Real orders opens on that range.
5. **Dashboard:** `orders.counts.late` matches `listQueue`'s `slaBreached` for every stage; the alert shows only
   when a count is above zero and links to the queue; the two extra tiles appear for `report.read` only.
6. **CSV:** each route's columns, filters, zone and locale headers; a cell starting with `=` is escaped; a purged
   order has an empty customer name; no customer address, email or phone column exists; the 100,000-row cap adds the cut
   row.
7. **Permissions:** every new procedure and every CSV route has allowed tests (Admin, and a Packer who also holds
   `REPORTS`) and a forbidden test (Picker, Packer, QA, Shipper, Rate Lab without it); the Reports nav item is
   hidden without `report.read`; a `REPORTS` user still can't reach settings or user admin; the role can be
   ticked in user admin and has `en`/`es` labels.
8. **Performance:** on 10,000 orders over 90 days (with their events, items and issues), each report read answers in
   under 1 s and a 90-day throughput CSV streams in under 5 s on the dev stack. (`reporting.bench.test.ts`,
   2026-11-18, with other suites loading the machine: Throughput ~0.3 s, Cycle time ~0.65–0.8 s, Quality ~0.3 s,
   home tiles <0.1 s, the CSV ~0.3 s. No rollup needed; Cycle time is the one to watch as volume grows.)
9. **UI:** one Playwright test opens each Reports tab with the seed, changes the range, checks a known figure,
   downloads one CSV, and checks a Packer sees no Reports item but sees the SLA alert.

## Assumptions

1. Reports access is `report.read`: Admins and holders of the new `REPORTS` role.
2. "Orders per stage per person" means the person who moved the order out of that stage. Someone who worked on an
   order but didn't finish the stage gets its units, not the order.
3. A line has one picker (`OrderItem.pickedById`, the last to pick it). A line picked by two people credits the
   second. This matches how picking stores it today.
4. 92 days is the longest range on screen; longer history comes from CSV in pieces.
5. Aggregates are computed on read, not stored. At our volume (hundreds of orders a day) indexed queries are fast
   enough; a rollup table can come later if criterion 8 fails.
6. Times are bucketed in the viewer's browser time zone, like the existing orders-per-day chart.
7. Exports need `report.read` because they leave the system; no export includes customer addresses, emails or
   phones.

## Decisions (2026-11-18)

1. **Spend reuses Rate Lab's Real orders** instead of a second report. FR-REP-03 is delivered by `rate-lab`.
2. **CSV for every list means:** All orders, Issues, Voids, order items, users, plus every report. Queues are
   covered by All orders filtered by status. Lots, manifests and Rate Lab already have theirs. (Items and users
   added 2026-11-18.)
3. **Quality shows per-person rates** (issues per 1,000 units, with a 100-unit floor) next to the counts, and
   blocked scans next to issues without calling them mistakes. Confirmed 2026-11-18: full per-person visibility is
   wanted, to see who needs more training, not to rank or blame.
4. **SLA alerts go on the home dashboard for everyone;** the report tiles only for `report.read`.
5. **Floor leads get a `REPORTS` add-on role,** not Admin: Admin can change settings, credentials and users, which
   a lead doesn't need.
6. **Idle cutoff of 10 minutes** for working time, applied in the shared summary so the History tab and Cycle time
   agree. Gaps over 10 minutes are shown as idle, not dropped.

## Open questions

None.
