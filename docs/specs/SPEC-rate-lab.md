# Spec: `rate-lab`

**Milestone:** M5 · **Depends on:** `rate-history` (the quote log it writes and reads), `carriers` (the seam,
registry, address validation, enabled carriers and services), `packing` (boxes), `shipping` (`buildCustoms`),
`settings` (ship-from, the run cap) · **Used by:** `reporting` (may reuse its real-order queries) · **State:**
spec approved

Project-wide commands, structure, code style, testing levels and boundaries are in [`../../SPEC.md`](../../SPEC.md);
this spec only adds what is specific to `rate-lab`.

## Objective

Give the warehouse a place to test shipping prices on purpose, and to see what real orders cost. Staff save **test
addresses** and **test parcels**, put them in groups, and run every address against every parcel through each
enabled provider. Every run is kept, so trends show how prices for the same address and parcel move over time. A
**one-off quote** answers "what would this cost?" for an address that isn't saved. The **Real orders** dashboard
reads the quotes `rate-history` keeps from real packages: what was chosen, what else was offered, and why.

- **SRS:** FR-REP-03 (spend by carrier and service; label cost vs. shipping charged), FR-REP-04 (CSV export) for
  its own reports. New: rate testing.
- **Users:** Admin and Shipper run tests, get one-off quotes and read runs and trends (`ratelab.use`). Admins
  manage test addresses, parcels and groups (`ratelab.manage`) and read Real orders (`report.read`, Admin only
  today).
- **Why now:** M4 shipped labels. Before we change carrier accounts or box sizes, we want to measure prices
  rather than guess, and see what real orders actually paid.

### User stories

1. As an admin, on **Rate Lab → Addresses** I add "Rural Montana ranch", tag it *Rural/remote* and *West*. It's
   checked when I save: the ZIP+4 is added and it's marked residential. I see both the address I typed and the
   corrected one.
2. On **Rate Lab → Parcels** I add "Medium box, 3 lb glass jar". I describe what it tests ("dimensional weight on
   the Medium box"), pick our **Medium** box (its size fills in), enter 48 oz, and tag it *Medium* and *Fragile*.
   For international tests I add its contents (1 × Glass jar candle) so customs can be declared.
3. As a shipper, on **Rate Lab → Runs** I press **New run**, keep the default "all addresses × all parcels" or pick
   groups, and see "12 addresses × 5 parcels = 60 combinations" before starting. The run appears at the top of the
   list with a progress bar. I can cancel it.
4. The runs list shows, like the sync page, when each run started, who started it, how long it took, its status,
   combinations, quotes, failures and the groups picked. I click a run.
5. The run page shows insights: the cheapest and fastest option per address × parcel, prices that moved ±10% or
   more since the last run with that combination, how often each carrier won, and failures per provider. Under them is
   the full quote table. **Export CSV** and **PDF report** sit at the top.
6. On **Rate Lab → Quote** I type an address, pick two saved parcels and add one by hand, and get quotes from
   every enabled provider in seconds. I like the address, so I press **Save as test address**.
7. On **Rate Lab → Trends** a heatmap shows addresses down the side and parcels across the top. Each cell is the latest
   cheapest price, coloured by how much it changed since the previous run. I click a cell and see a line per
   carrier and service over time.
8. As an admin, **Rate Lab → Real orders** shows, for the last 30 days: how often QA picked a pricier rate and what
   that cost, broken down by reason; carrier and service share; cost per lane over time; and label cost vs. the
   shipping customers paid.

## Scope

**In:**
- Test addresses, test parcels, groups (tags) for each, archive and duplicate, with physical fields locked once used.
- Address check on save (and **Re-check**), through carriers' validation.
- Runs: selection, the combination cap, a background job, progress, cancel, one run at a time, statuses.
- One-off quotes, saved as `ONE_OFF` runs, with **Save as test address** / **Save parcel**.
- Run detail with insights; Trends (heatmap + line chart); Real orders dashboard.
- CSV export of run detail and Real orders; print-ready report pages (run, Trends, Real orders) for "Save as PDF".
- A sidebar entry and its own page; a cap setting on Settings → Shipping.
- New dependency: **Recharts** (approved with this spec, decision 9).

**Out:**
- Scheduled runs (decision 6). The tables allow adding them later.
- Anomaly detection, rule suggestions, dimensional-weight hints, surcharge detection, savings what-ifs: later.
- Server-rendered or emailed PDFs (decision 10).
- Retrying only the failed combinations (decision 7).
- Buying labels from the lab. Rate Lab never calls `purchaseLabel`.
- Quoting disabled carriers or services (decision 3).

## Design

### Permissions (`packages/core/src/permissions.ts`)

New: `ratelab.use` (Admin, Shipper), `ratelab.manage` (Admin). Real orders uses the existing `report.read`.

### Data (`packages/db/prisma/schema/rate-lab.prisma`, new file)

```prisma
enum RateLabGroupKind { ADDRESS PARCEL  @@map("rate_lab_group_kind") }
enum RateLabRunKind   { SUITE ONE_OFF   @@map("rate_lab_run_kind") }
enum RateLabRunStatus { QUEUED RUNNING SUCCEEDED PARTIAL FAILED CANCELLED  @@map("rate_lab_run_status") }

model RateLabGroup {
  id         String           @id @default(uuid(7)) @db.Uuid
  kind       RateLabGroupKind
  name       String           // ≤ 60, unique per kind (case-insensitive, hand-written index)
  archivedAt DateTime?        @map("archived_at") @db.Timestamptz(3)
  // timestamps; many-to-many to addresses or parcels by kind
  @@map("rate_lab_groups")
}

model RateLabAddress {
  id            String       @id @default(uuid(7)) @db.Uuid
  title         String       // ≤ 80, e.g. "Rural Montana ranch"
  description   String?      // ≤ 500, what it tests
  /// ShipAddress as typed.
  original      Json
  /// ShipAddress used for quotes: the corrected one when the check corrected it.
  address       Json
  residential   Boolean
  checkStatus   ShipToStatus @map("check_status")      // reuses carriers' enum
  checkMessages Json         @default("[]") @map("check_messages")
  checkedAt     DateTime?    @map("checked_at") @db.Timestamptz(3)
  /// Set by the first run that quotes it; physical fields are then read-only (decision 5).
  lockedAt      DateTime?    @map("locked_at") @db.Timestamptz(3)
  archivedAt    DateTime?    @map("archived_at") @db.Timestamptz(3)
  createdById   String?      @map("created_by_id") @db.Uuid
  // timestamps, groups
  @@map("rate_lab_addresses")
}

model RateLabParcel {
  id          String    @id @default(uuid(7)) @db.Uuid
  title       String    // ≤ 80
  description String?   // ≤ 500
  /// The box it was made from; size copied below (a later box edit doesn't change the parcel).
  boxId       String?   @map("box_id") @db.Uuid               // SetNull
  lengthIn    Decimal   @map("length_in") @db.Decimal(8, 2)
  widthIn     Decimal   @map("width_in") @db.Decimal(8, 2)
  heightIn    Decimal   @map("height_in") @db.Decimal(8, 2)
  weightOz    Decimal   @map("weight_oz") @db.Decimal(10, 2)
  lockedAt    DateTime? @map("locked_at") @db.Timestamptz(3)
  archivedAt  DateTime? @map("archived_at") @db.Timestamptz(3)
  createdById String?   @map("created_by_id") @db.Uuid
  // timestamps, groups, contents
  @@map("rate_lab_parcels")
}

/// What's in a parcel, for customs and the shipment's items (decision 4).
model RateLabParcelItem {
  id        String @id @default(uuid(7)) @db.Uuid
  parcelId  String @map("parcel_id") @db.Uuid    // Cascade
  productId String @map("product_id") @db.Uuid   // Restrict
  quantity  Int                                  // 1–999
  @@unique([parcelId, productId])
  @@map("rate_lab_parcel_items")
}

model RateLabRun {
  id                    String           @id @default(uuid(7)) @db.Uuid
  kind                  RateLabRunKind
  status                RateLabRunStatus @default(QUEUED)
  startedById           String?          @map("started_by_id") @db.Uuid   // SetNull
  /// { addressGroupIds, addressIds, parcelGroupIds, parcelIds } as chosen; empty lists = all active.
  selection             Json
  /// Ship-from at the time of the run (decision 8).
  shipFrom              Json             @map("ship_from")
  /// ONE_OFF only: the address typed. Cleared by the PII purge (below).
  adHocAddress          Json?            @map("ad_hoc_address")
  /// ONE_OFF only: parcels typed in, as { lengthIn, widthIn, heightIn, weightOz, boxId? }[].
  adHocParcels          Json?            @map("ad_hoc_parcels")
  combinations          Int
  completedCombinations Int              @default(0) @map("completed_combinations")
  quoteCount            Int              @default(0) @map("quote_count")
  failureCount          Int              @default(0) @map("failure_count")
  fake                  Boolean          @default(false)
  cancelRequestedAt     DateTime?        @map("cancel_requested_at") @db.Timestamptz(3)
  error                 String?          // message key when the whole run failed
  createdAt             DateTime         @default(now()) @map("created_at") @db.Timestamptz(3)
  startedAt             DateTime?        @map("started_at") @db.Timestamptz(3)
  finishedAt            DateTime?        @map("finished_at") @db.Timestamptz(3)
  heartbeatAt           DateTime?        @map("heartbeat_at") @db.Timestamptz(3)

  fetches RateFetch[]
  @@index([createdAt(sort: Desc)])
  @@map("rate_lab_runs")
}
```

Quotes themselves live in `rate-history`'s `RateFetch` / `RateQuote` (`source = LAB`, `trigger = LAB_RUN`): one
fetch per combination. A combination that failed for every provider is a fetch with zero quotes and its errors, so
"failures" is a query, not another table. This migration adds the FKs from `rate_fetches.lab_run_id` (Cascade),
`lab_address_id` and `lab_parcel_id` (Restrict: archived, never deleted). One-off combinations with a typed address
or parcel leave `lab_address_id` / `lab_parcel_id` null.

`Settings` gains `rateLabMaxCombinations Int @default(250)` (1–2000).

Hand-written SQL at the end of the migration:
- One active run: a partial unique index on `rate_lab_runs ((true)) WHERE kind = 'SUITE' AND status IN ('QUEUED','RUNNING')`.
- Group names unique per kind, case-insensitive: `UNIQUE (kind, lower(name))`.
- `ad_hoc_*` only on `ONE_OFF` runs.

### Addresses and parcels (`packages/core/src/rate-lab/catalog.ts`)

| Function | Permission | Rule |
|---|---|---|
| `listLabAddresses` / `listLabParcels` | `ratelab.use` | Filters: group, archived (default hidden), text search on title. Each with groups, locked, last quoted at. |
| `createLabAddress` | `ratelab.manage` | Zod-validated `ShipAddress` (US states validated as carriers does). Runs the address check (below), stores `original`, `address`, `residential`, status. Audited. |
| `updateLabAddress` | `ratelab.manage` | Title, description, groups always; address fields only while `lockedAt` is null (`errors.rateLab.locked`), which re-runs the check. Audited. |
| `recheckLabAddress` | `ratelab.manage` | Runs the check again on `original`. Allowed when locked only if the result doesn't change `address` or `residential`; otherwise refused with `errors.rateLab.recheckChanged`, and the screen offers **Duplicate**. |
| `createLabParcel` / `updateLabParcel` | `ratelab.manage` | `boxId` (copies its inner size) **or** typed size; weight; optional contents (physical products only). Size, weight and contents frozen once locked. Audited. |
| `duplicateLabAddress` / `duplicateLabParcel` | `ratelab.manage` | Copy with title "… (copy)", unlocked, same groups. |
| `archive…` / `unarchive…` | `ratelab.manage` | Archived items are never run, stay in history and trends. |
| `listLabGroups`, `createLabGroup`, `renameLabGroup`, `archiveLabGroup` | `use` to list, `manage` to change | Tags; an item can be in many groups (decision 2). |

**Address check:** reuses carriers' validation through the first enabled provider with `addressValidation`, and the
same status mapping (verified / corrected / warning / error / unchecked). Residential is the provider's answer,
else "no company name". Validation never blocks the save.

**Locking:** a run's job sets `lockedAt` on every address and parcel it quotes, in the transaction that logs the first
fetch for it.

### Runs (`packages/core/src/rate-lab/runs.ts`, job `rateLab.run`)

`startLabRun({ selection })` (`ratelab.use`):
1. Resolve the selection: addresses = active ones in any chosen group or chosen by id (all active when both are
   empty); same for parcels. Zero on either side → `errors.rateLab.emptySelection`.
2. `combinations = addresses × parcels`. Over `Settings.rateLabMaxCombinations` → `errors.rateLab.overCap
   { combinations, cap }`, nothing created.
3. No enabled provider → `errors.rateLab.noProviders`. Ship-from not set → `errors.settings.shipFromMissing`.
4. Insert the run (`QUEUED`, ship-from snapshot) and enqueue `rateLab.run { runId }` in the same transaction. The
   one-active-run index turns a second start into `errors.rateLab.runActive`. Audited.

`previewLabRun({ selection })` (`ratelab.use`) returns the counts and whether it's over the cap, for the **New
run** dialog.

**The job:** marks `RUNNING`, `startedAt`, and works through combinations three at a time (`LAB_CONCURRENCY`). For
each one:
- Build a `RateRequest`: ship-from from the run, ship-to = the address's `address`, `residential`, the parcel's
  size and weight, `items` from the contents (or one line with the parcel title), `orderNumber` = `LAB-<run id
  short>`, and for an international combination `customs` from `buildCustoms` over the contents at each product's
  `priceCents`. Services = each provider's enabled carriers and services matching domestic/international, the same
  selection as `rates.fetch` (decision 3).
- International with no contents or incomplete customs → logged as a failed combination with
  `errors.shipping.customsIncomplete`, no provider called.
- Call each enabled provider's `getRates` in parallel within `PROVIDER_TIMEOUT_MS`; never retry inside a run.
- `logRateFetch` (source `LAB`, the run, address and parcel ids, lane, parcel, quotes, errors, fake flags), then
  increment `completedCombinations`, `quoteCount` and `failureCount` (a combination counts as one failure per
  provider that errored), and bump `heartbeatAt`.
- Between combinations, if `cancelRequestedAt` is set: stop, status `CANCELLED`.

End status: `SUCCEEDED` (no provider errors), `PARTIAL` (some), `FAILED` (no quotes at all, or an unexpected error;
`error` set). `fake` = any fake provider was used. The job runs once (`retryLimit: 0`); a re-run is a new run
(decision 7).

**Stuck runs:** `startLabRun` and the runs list first mark any `RUNNING` run whose `heartbeatAt` (or `startedAt`)
is older than 10 minutes as `FAILED` with `errors.rateLab.stalled`, so a dead worker never blocks the next run.

`cancelLabRun({ runId })` (`ratelab.use`): sets `cancelRequestedAt` on a `QUEUED` or `RUNNING` run; a `QUEUED` one
becomes `CANCELLED` at once. Audited.

### One-off quotes (`packages/core/src/rate-lab/one-off.ts`)

`quoteOneOff({ address, parcelIds?, parcelGroupIds?, adHocParcels? })` (`ratelab.use`): at least one parcel; total
parcels ≤ 20. It checks the address (not stored as a test address), creates a `ONE_OFF` run and runs it **inline** in
the request: one-offs are small, and the person is waiting. The one-active-run rule doesn't apply to `ONE_OFF`
(the index covers `SUITE` only). It returns the run id; the Quote tab shows its quotes. One-off fetches are excluded
from Trends (decision 12).

`saveOneOffAddress({ runId, title, groupIds })` and `saveOneOffParcel({ runId, index, title, groupIds })`
(`ratelab.manage`) create a test address or parcel from it.

**PII:** a one-off address may be a real customer's. The PII purge (`operations`, edit to SPEC-operations) also
clears `adHocAddress` on one-off runs older than `Settings.piiRetentionDays`; the lane in its fetches stays.

### Insights (`packages/core/src/rate-lab/insights.ts`, pure)

`runInsights(quotesByCombination, previousByCombination)` returns:
- **Per combination:** cheapest (purchasable first, quote-only marked) and fastest (fewest delivery days, then
  price); a combination with no quotes is listed as failed.
- **Moves:** per combination × carrier service, the change vs. the most recent earlier `SUITE` run that had the
  same address, parcel and service. Flagged at |Δ| ≥ 10% (`PRICE_MOVE_PCT`); new and missing services listed
  too.
- **Carrier wins:** how many combinations each carrier service was cheapest for.
- **Failures:** per provider, the count and each error key.

### Trends (`packages/core/src/rate-lab/trends.ts`)

- `labTrendGrid({ addressGroupIds?, parcelGroupIds?, carrierIds?, from?, to?, includeFake? })` (`ratelab.use`):
  one cell per active address × parcel with the latest `SUITE` run's cheapest quote, the change vs. the run before,
  and the run id.
- `labTrendSeries({ addressId, parcelId, carrierIds?, from?, to?, includeFake? })`: per carrier service, one point
  per `SUITE` run (run time, amount, delivery days).
- Fake data is excluded unless `includeFake` (SPEC-rate-history decision 6).

### Real orders (`packages/core/src/rate-lab/real-orders.ts`, `report.read`)

All over `ShippingLabel` rows with `rateQuoteId`, status `ACTIVE` (bought and not voided), `purchasedAt` in range
(default the last 30 days), joined to the label's fetch and quotes. Per package, with order totals
where noted. Filters: date range, carrier, service, destination country/state, box, include fake.
- **Choice:** packages, % on the cheapest, % not, overspend = Σ(bought quote − that fetch's cheapest), split by
  reason (including "no reason").
- **Share:** packages and spend by carrier and by service.
- **Lane cost:** median and mean bought cost per country + state per week.
- **Label cost vs. charged:** per order, Σ label cost (`costCents`, else `quotedAmountCents`) vs.
  `Order.shippingChargedCents`; totals, and orders where cost > charged.
- **Alternatives:** for each package, the bought quote with the other quotes of its fetch (the table under the
  charts).

### Exports

- **CSV** (FR-REP-04): Route Handlers (like `api/label-prints`) at `GET /api/rate-lab/runs/{id}/export.csv` and
  `GET /api/rate-lab/real-orders/export.csv?from&to&…`, session-checked with the same permission, streaming one row
  per quote: run/order, address title or lane, parcel, provider, carrier, service, amount, delivery days,
  cheapest, bought, reason. RFC 4180 quoting, UTF-8 with BOM (Excel), and a leading `=+-@` in text cells is
  prefixed with `'` (CSV injection).
- **PDF** (decision 10): print-ready pages `/rate-lab/runs/[id]/report`, `/rate-lab/trends/report?…`,
  `/rate-lab/real-orders/report?…`, styled for `@media print` (light theme, A4/Letter, no nav, page breaks between
  sections). **PDF report** opens the page and calls `window.print()`.
  - Run report: summary (when, who, duration, groups, counts), insights, cheapest/fastest table, a trend section
    with a small chart per combination over its last 10 `SUITE` runs, and the full quote table.
  - Trends report: the heatmap and the line chart of each combination in the current filters (at most 60;
    beyond that the report says how many were left out).
  - Real orders report: the headline numbers, the charts and the carrier/service table for the range.

### API (oRPC, `packages/contracts/src/rate-lab.ts`)

| Procedure | Route |
|---|---|
| `rateLab.addresses` / `createAddress` / `updateAddress` / `recheckAddress` / `duplicateAddress` / `archiveAddress` / `unarchiveAddress` | `GET/POST /rate-lab/addresses`, `PATCH /rate-lab/addresses/{id}`, `POST …/{id}/recheck`, `…/duplicate`, `…/archive`, `…/unarchive` |
| the same for parcels | `/rate-lab/parcels…` |
| `rateLab.groups` / `createGroup` / `renameGroup` / `archiveGroup` | `/rate-lab/groups…` |
| `rateLab.previewRun` / `startRun` / `cancelRun` | `POST /rate-lab/runs/preview`, `POST /rate-lab/runs`, `POST /rate-lab/runs/{id}/cancel` |
| `rateLab.runs` / `run` | `GET /rate-lab/runs` (paged, newest first), `GET /rate-lab/runs/{id}` (summary, insights, quotes) |
| `rateLab.quoteOneOff` / `saveOneOffAddress` / `saveOneOffParcel` | `POST /rate-lab/quote`, `POST /rate-lab/runs/{id}/save-address`, `…/save-parcel` |
| `rateLab.trendGrid` / `trendSeries` | `GET /rate-lab/trends`, `GET /rate-lab/trends/series` |
| `rateLab.realOrders` | `GET /rate-lab/real-orders` |
| `settings` | `rateLabMaxCombinations` joins the shipping settings update |

### UI (`apps/web/src/app/(app)/rate-lab/`)

- **Sidebar:** a **Rate Lab** entry for `ratelab.use` (Admin, Shipper), next to Manifests. The layout has tabs:
  **Runs · Addresses · Parcels · Quote · Trends · Real orders** (Real orders only with `report.read`).
- **Runs:** a table modelled on `sync/sync-runs.tsx`: started at, started by, duration, status badge, combinations,
  quotes, failures, groups. **New run** dialog with group/item pickers and the live combination count (red and
  disabled over the cap). A running run shows a progress bar (`completed / combinations`) and **Cancel**; the list
  polls every 3 s while a run is active. Rows open `/rate-lab/runs/[id]`.
- **Run detail:** summary header, insight cards, then a TanStack table of quotes grouped by address × parcel
  (cheapest and fastest marked by text badges, not colour alone), filters by carrier, provider and status;
  **Export CSV**, **PDF report**, **Run again** (same selection).
- **Addresses / Parcels:** tables with group filters and an archived toggle; forms in a drawer; a lock icon and
  "Used in runs: physical fields locked. Duplicate to change." on locked items. The address form shows typed vs.
  corrected like the order's ship-to.
- **Quote:** the address form plus a parcel picker (saved parcels, groups, **Add parcel** by hand); results are
  a table per parcel; **Save as test address** / **Save parcel** for Admins.
- **Trends:** filters; the heatmap (a CSS grid, colour scale plus the % in text); clicking a cell opens the Recharts
  line chart below; **PDF report**.
- **Real orders:** date range (default 30 days) and filters; stat tiles; Recharts bar charts (reason, carrier share)
  and a line chart (lane cost over time); the alternatives table; **Export CSV**, **PDF report**.
- **Settings → Shipping:** a "Rate Lab" card with the combination cap.
- Charts read theme colours from daisyUI CSS variables, so they work in light and dark; every chart has a table
  or text equivalent for screen readers. All strings in `en` and `es`.

### Dev data

`pnpm db:seed` adds 6 test addresses (2 corrected by the ShipStation fake's "Street" rule, 1 Canadian), 4 parcels
(2 from seeded boxes, 1 with contents for customs), and groups, plus 3 finished `SUITE` runs a week apart from the
fakes with slightly drifting prices, so Trends has lines in dev.

### Files expected to change

`packages/db/prisma/schema/{rate-lab,shipping,system}.prisma` + one migration, `packages/db/prisma/seed*.ts`,
`packages/core/src/rate-lab/**` (+ tests), `packages/core/src/permissions.ts`, `packages/core/src/jobs.ts`,
`packages/core/src/operations/pii-purge.ts`, `packages/core/src/settings/**`, `packages/core/src/index.ts`,
`apps/worker/src/**`, `packages/contracts/src/{rate-lab,settings,index}.ts`, `apps/web/src/server/router.ts`,
`apps/web/src/app/(app)/rate-lab/**`, `apps/web/src/app/api/rate-lab/**`, `apps/web/src/app/(app)/layout.tsx`,
`apps/web/src/app/(app)/settings/shipping/**`, `apps/web/package.json` (Recharts), `packages/i18n/src/messages/{en,es}.json`,
`apps/web/e2e/rate-lab.spec.ts`, `docs/specs/SPEC-operations.md` (purge edit).

## Success criteria

1. **Addresses:** creating one runs the check and stores original, corrected and residential; with no validating
   provider it saves as `UNCHECKED`. Once a run has quoted it, editing an address field is refused, while title,
   description and groups still change; **Duplicate** gives an unlocked copy.
2. **Parcels:** a parcel from a box copies its size and keeps `boxId`; a later box edit doesn't change it; locked
   parcels refuse size, weight and contents changes; non-physical products can't be added as contents.
3. **Groups:** an item in two groups is selected once when both are chosen; archived items and groups are never
   run.
4. **Selection and cap:** preview counts match; over the cap is refused with both numbers and creates nothing;
   empty selection and no enabled provider are refused.
5. **One active run:** starting a second `SUITE` run while one is `QUEUED`/`RUNNING` is refused (the DB index,
   tested directly); a one-off still works during a run; a run with an old heartbeat is marked `FAILED` and no
   longer blocks.
6. **The job:** with two fake providers, a 3 × 2 run logs 6 LAB fetches tied to the run, address and parcel, with
   only enabled services matching domestic/international; counts and `completedCombinations` are right;
   addresses and parcels get `lockedAt`.
7. **Statuses:** all good → `SUCCEEDED`; one provider timing out → `PARTIAL` with failures counted; no quotes →
   `FAILED`; cancel mid-run stops between combinations → `CANCELLED`, with the finished combinations kept.
8. **Customs:** an international combination without contents logs `customsIncomplete` and calls no provider;
   with contents, the request carries a declaration built by `buildCustoms`.
9. **Never buys:** a spy on the fakes proves no `purchaseLabel` call in any lab path.
10. **One-off:** returns quotes for each parcel inline; is excluded from Trends; **Save as test address** creates
    an unlocked address with the typed original; the PII purge clears `adHocAddress` after the retention period
    and keeps the fetches.
11. **Insights:** unit tests on `runInsights`: cheapest prefers purchasable, fastest tie-break, a 10% move flagged
    and a 9.9% one not, new and missing services, carrier wins, failures per provider; comparison uses the most
    recent earlier `SUITE` run with that combination.
12. **Trends:** the grid's latest cell and delta, and the series points, match seeded runs; fake data is hidden
    unless asked.
13. **Real orders:** on seeded labels, the cheapest-pick %, overspend (with the reason split), carrier share, lane
    cost and cost-vs-charged figures are exact; voided labels are excluded.
14. **CSV:** column set and quoting; a title starting with `=` is escaped; forbidden without the permission.
15. **Permissions:** every procedure and both CSV routes have allowed and forbidden tests (a Shipper can run but
    not edit addresses; a Shipper can't read Real orders; a Picker can't open Rate Lab).
16. **Performance:** a 250-combination run against fakes at 1 s latency finishes in under 2 minutes; `run` loads
    a 250-combination × 10-quote run in under 500 ms p95; Real orders over 10,000 packages loads in under 1 s.
17. **E2E (desktop), fake providers:** an admin adds two addresses and two parcels in a group → a shipper starts a
    run, sees progress, opens the finished run and sees insights → exports CSV (download received) → opens the PDF
    report page → does a one-off quote → Trends shows a cell per combination. A Picker doesn't see Rate Lab. The
    run report page has no nav and fits the print width (checked with `page.emulateMedia({ media: "print" })`).
18. Green: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`, `migrate:check`, plus Playwright.

## Assumptions

1. Quoting costs nothing with either provider; only labels cost money (user, 2026-11-03).
2. Ship-from is the one Settings address; currency USD.
3. Test addresses and parcels number in the tens, not thousands.
4. Recharts' current major works with React 19 (checked when the ticket adds it; exact version pinned).
5. Rate Lab users are on desktops; the pages work on tablets but aren't tuned for them.

## Decisions (2026-11-03)

1. **Name:** Rate Lab, module `rate-lab`, its own sidebar entry and page.
2. **Addresses and parcels are separate**, each with title, description and many groups (tags); a run is address
   selection × parcel selection, defaulting to all × all. Trends are per address × parcel.
3. **Only enabled carriers and services** are quoted, exactly what QA sees.
4. **Customs from contents:** a parcel lists catalog products and quantities, and the declaration is built with
   `shipping`'s `buildCustoms` from their HS code, origin and price. There are no global customs defaults to fall
   back on, so contents are the only source.
5. **Lock after use:** physical fields freeze once an item has been quoted; change them by duplicating.
6. **Manual runs only**, one at a time, cancellable; no schedule for now.
7. **Re-run = a new run** with the same selection; no retry of failures alone. Runs never retry by themselves.
8. **Ship-from is snapshotted** on each run.
9. **Recharts** is the one new dependency, for Rate Lab now and `reporting` later.
10. **PDF = print-ready pages** and the browser's "Save as PDF", no server rendering.
11. **Run cap** counts combinations, set on Settings → Shipping, default 250.
12. **One-off quotes** are saved as `ONE_OFF` runs, kept out of Trends, and can be saved as test addresses and
    parcels.
13. **Permissions:** `ratelab.use` for Admin and Shipper, `ratelab.manage` and Real orders (`report.read`) for Admin.

## Open questions

1. **ShipStation shipments from quotes:** ShipStation v2's `POST /v2/rates` with an inline shipment may create a
   shipment record in the ShipStation account. If so, every lab combination leaves one there. To check against the
   v2 reference when the job ticket is built. If it does, we either accept it (they're never labelled) or pass a
   flag that avoids it, if the API has one.
2. **QA role access:** QA picks rates every day but isn't in `ratelab.use` (decided: Admin and Shipper). Should QA
   see Rate Lab too?
