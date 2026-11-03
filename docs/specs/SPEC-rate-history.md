# Spec: `rate-history`

**Milestone:** M5 · **Depends on:** `carriers` (the rate fetch and the seam), `qa` (rate selection, label purchase)
· **Used by:** `rate-lab` (writes Lab fetches, reads both for its dashboards), `reporting` (spend and choice
statistics, later) · **State:** done

Project-wide commands, structure, code style, testing levels and boundaries are in [`../../SPEC.md`](../../SPEC.md);
this spec only adds what is specific to `rate-history`.

## Objective

Keep every shipping quote Woolrus ever receives, so we can learn from real shipping data: what we chose, what
else was on offer, and what each lane costs over time. Today `carriers` **deletes** a package's rates on every
refresh, repack and address change, and only the bought label keeps `quotedAmountCents`. The alternatives are
gone the moment a label is bought.

This module adds an append-only quote log beside the working rates. It has no screens of its own; it starts
collecting the day it ships, so `rate-lab`'s dashboards have history to show when they land.

- **SRS:** groundwork for FR-REP-03 (spend by carrier and service, label cost vs. shipping charged). New: quote
  history and the reason for a pricier pick.
- **Users:** nobody sees it directly. QA (`order.qa`) gets one optional field when picking a rate that isn't the
  cheapest.
- **Why now:** history can only be shown from the day it starts being saved. Building this before `rate-lab`
  means real-order data is already there when the dashboards are.

### User stories

1. As QA, I pick UPS Ground over the pre-selected cheaper USPS rate. A small optional "Why?" picker appears
   (Faster delivery / Customer requested / Carrier reliability / Cheapest unavailable or failed / Other). I can
   ignore it and buy the label.
2. As an admin, months later, the Real orders dashboard (`rate-lab`) shows that 14% of packages went out on a
   pricier rate, how much that cost, and why, because every fetch and choice was kept.

## Scope

**In:**
- Schema: `RateFetch` and `RateQuote` (append-only), the selection reason on `ShippingRate` and `ShippingLabel`,
  and the link from a rate and a label to its logged quote.
- Writing a `RateFetch` + its `RateQuote`s in the same transaction as every `rates.fetch` write, including
  fetches where every provider failed.
- An optional selection reason on `qa.selectRate`; copied onto the label at purchase.
- Marking which logged quote a label was bought from.
- A `fake` flag on each fetch and quote, from a new `fake` marker on the seam.
- A core write helper `logRateFetch` that `rate-lab` reuses for its own fetches.

**Out:**
- Any screen, chart or query beyond what tests need: `rate-lab`.
- Backfill. V2 hasn't gone live, so there is no history to recover (decision 4).
- Changing how the working rates (`ShippingRate`) behave. They are still replaced on every fetch.
- Retention or pruning: kept forever for now (decision 5).

## Design

### The log (`packages/db/prisma/schema/shipping.prisma`)

```prisma
enum RateFetchSource {
  ORDER
  LAB

  @@map("rate_fetch_source")
}

/// What caused an order's fetch: packing finished, Refresh rates, an address action, a Woo address change.
enum RateFetchTrigger {
  PACKING_COMPLETE
  REFRESH
  ADDRESS_CHANGE
  LAB_RUN

  @@map("rate_fetch_trigger")
}

/// One package (or one Rate Lab test case) quoted once. Append-only: never updated except `rate-lab`'s link.
model RateFetch {
  id            String           @id @default(uuid(7)) @db.Uuid
  source        RateFetchSource
  trigger       RateFetchTrigger
  /// ORDER only. SetNull: a package deleted before its label (packing) keeps its history.
  orderId       String?          @map("order_id") @db.Uuid
  packageId     String?          @map("package_id") @db.Uuid
  /// LAB only; FK added by rate-lab's migration.
  labRunId      String?          @map("lab_run_id") @db.Uuid
  labAddressId  String?          @map("lab_address_id") @db.Uuid
  labParcelId   String?          @map("lab_parcel_id") @db.Uuid
  // The lane, never the full address (decision 3).
  destCountry   String           @map("dest_country") @db.Char(2)
  destState     String?          @map("dest_state")
  /// First three characters of the postal code, for later drill-down.
  destZip3      String?          @map("dest_zip3")
  residential   Boolean
  international Boolean
  // The parcel as quoted.
  boxId         String?          @map("box_id") @db.Uuid
  lengthIn      Decimal          @map("length_in") @db.Decimal(8, 2)
  widthIn       Decimal          @map("width_in") @db.Decimal(8, 2)
  heightIn      Decimal          @map("height_in") @db.Decimal(8, 2)
  weightOz      Decimal          @map("weight_oz") @db.Decimal(10, 2)
  /// [{ provider, messageKey, params? }] for providers that failed, as on Package.rateErrors.
  providerErrors Json            @default("[]") @map("provider_errors")
  /// Any provider in this fetch was a fake adapter (decision 6).
  fake          Boolean
  fetchedAt     DateTime         @default(now()) @map("fetched_at") @db.Timestamptz(3)

  quotes RateQuote[]
  // relations to Order, Package (SetNull) and Box (SetNull)

  @@index([source, fetchedAt(sort: Desc)])
  @@index([orderId])
  @@index([packageId])
  @@index([labRunId])
  @@index([labAddressId, labParcelId, fetchedAt])
  @@map("rate_fetches")
}

model RateQuote {
  id                  String             @id @default(uuid(7)) @db.Uuid
  fetchId             String             @map("fetch_id") @db.Uuid
  provider            ShippingProviderId
  carrierId           String             @map("carrier_id") @db.Uuid
  serviceId           String             @map("service_id") @db.Uuid
  carrierCode         String             @map("carrier_code")
  serviceCode         String             @map("service_code")
  serviceName         String             @map("service_name")
  amountCents         Int                @map("amount_cents")
  currency            String             @db.Char(3)
  deliveryDays        Int?               @map("delivery_days")
  estimatedDeliveryAt DateTime?          @map("estimated_delivery_at") @db.Timestamptz(3)
  guaranteed          Boolean
  /// The provider couldn't buy at fetch time (capability `purchase: false`).
  quoteOnly           Boolean            @map("quote_only")
  /// Cheapest purchasable quote of its fetch, by the same rule as carriers' pre-selection.
  cheapest            Boolean
  fake                Boolean
  createdAt           DateTime           @default(now()) @map("created_at") @db.Timestamptz(3)

  fetch   RateFetch       @relation(fields: [fetchId], references: [id], onDelete: Cascade)
  carrier ShippingCarrier @relation(fields: [carrierId], references: [id], onDelete: Restrict)
  service CarrierService  @relation(fields: [serviceId], references: [id], onDelete: Restrict)
  rates   ShippingRate[]
  labels  ShippingLabel[]

  @@index([fetchId])
  @@index([carrierId, serviceId, createdAt])
  @@map("rate_quotes")
}

/// Why QA picked a rate other than the cheapest. Optional (decision 2).
enum RateSelectionReason {
  FASTER_DELIVERY
  CUSTOMER_REQUESTED
  CARRIER_RELIABILITY
  CHEAPEST_UNAVAILABLE
  OTHER

  @@map("rate_selection_reason")
}
```

Additions to existing models:
- **`ShippingRate`:** `quoteId` (FK → `RateQuote`, Restrict; nullable only for rows that existed before the
  migration), `selectionReason RateSelectionReason?`, `selectionNote String?` (≤ 200).
- **`ShippingLabel`:** `rateQuoteId` (FK → `RateQuote`, Restrict, nullable: return labels and older labels have
  none), `selectionReason`, `selectionNote`, copied from the selected rate at purchase.

`RateFetch` stores no name, street or full postal code, so the PII purge (`operations`) needs no change for it.

### Writing the log (`packages/core/src/rate-history/log.ts`)

`logRateFetch(tx, input): Promise<{ fetchId, quoteIds }>` (`quoteIds[i]` is the quote of `input.rates[i]`) — pure insert, no permission check (callers already
hold theirs). `input` = source, trigger, the order/package or lab ids, the ship-to (reduced to the lane inside the
helper, so callers can't leak a full address by mistake), residential, international, the parcel, the provider
errors, the rates as `ProviderRate` + resolved carrier and service ids, and which providers were fake.
`cheapest` is computed inside with carriers' existing tie rule (fewer delivery days, then provider order, then
service name) among non-quote-only quotes.

`carriers`' `rates.fetch` (edit to `packages/core/src/carriers/rates.ts`, step 4): in the same per-package
transaction, after the generation check passes, call `logRateFetch` and set `quoteId` on each inserted
`ShippingRate`. A fetch whose generation is stale writes **nothing**, log included: it never reached QA, so it isn't
history. A fetch where every provider failed is still logged with zero quotes and its errors (lets `rate-lab` show
provider failure rates). Extras the provider returned for services that aren't enabled are dropped before logging,
as they are for `ShippingRate`.

The trigger comes from the job payload: `rates.fetch` gains `trigger` (default `PACKING_COMPLETE` for jobs already
queued at deploy). `refreshRates` sends `REFRESH`; `recheckAddress`, `keepOriginalAddress` and the Woo address
change send `ADDRESS_CHANGE`.

### Choice and purchase (`packages/core/src/qa/`)

- `selectRate({ packageId, rateId, reason?, note? })`: `reason` is accepted only when the chosen rate isn't the
  package's cheapest purchasable rate (`errors.qa.reasonNotNeeded` otherwise, so the data stays clean). `note` only
  with `OTHER`. Both stored on the selected `ShippingRate`, cleared when another rate is selected. Audited in the
  existing `rate.select` event.
- `setRateSelectionReason({ packageId, reason, note? })` (`order.qa`, same preconditions as `selectRate`): lets QA
  add or change the reason after picking, without re-selecting.
- Label purchase (`qa/complete.ts`): the new label row also gets `rateQuoteId`, `selectionReason`, `selectionNote`
  from the selected rate. That's the "fetch the label was bought from" every real-order statistic compares against
  (decision 1).

### Fake marker (edit to SPEC-carriers, the seam)

`ShippingProvider` gains `readonly fake?: true`. Both fakes set it; real adapters don't. The registry is unchanged.

### API (`packages/contracts/src/qa.ts`)

| Procedure | Change |
|---|---|
| `qa.selectRate` | input gains `reason?`, `note?` |
| `qa.setRateSelectionReason` | new: `POST /packages/{packageId}/selected-rate/reason` |

`carriers.orderShipping` returns `cheapest` per rate and the selected rate's `selectionReason`/`selectionNote`.

### UI (`apps/web/src/app/(app)/qa/`)

Under the package's rate table, when the selected rate isn't the cheapest purchasable one: a compact React Aria
`Select` "Why this rate? (optional)" with the five reasons, and a note field when **Other** is chosen. Saved on
change; never blocks **Complete QA**. The order drawer shows the reason next to the selected rate. Strings in `en` and
`es`.

### Schema changes (approved with this spec)

One migration: the two enums for source/trigger, `RateSelectionReason`, `rate_fetches`, `rate_quotes`, the columns
on `shipping_rates` and `shipping_labels`. Hand-written check constraints at its end:
- `rate_fetches`: `source = 'ORDER'` ⇒ `lab_*` all null; `source = 'LAB'` ⇒ `order_id` and `package_id` null and
  `lab_run_id` not null.
- `shipping_rates` and `shipping_labels`: `selection_note` only when `selection_reason = 'OTHER'`.

The init migration's constraints are untouched.

### Files expected to change

`packages/db/prisma/schema/shipping.prisma` + one migration, `packages/core/src/rate-history/{log,index}.ts` (+
tests), `packages/core/src/carriers/{rates,address}.ts`, `packages/core/src/adapters/shipping/{provider,fake}.ts`,
`packages/core/src/qa/{rates,complete}.ts`, `packages/core/src/store-sync/**` (trigger on address change),
`packages/core/src/jobs.ts`, `packages/contracts/src/{qa,carriers}.ts`, `apps/web/src/server/router.ts`,
`apps/web/src/app/(app)/qa/**`, `packages/i18n/src/messages/{en,es}.json`, `packages/core/test/factories.ts`,
`docs/specs/SPEC-carriers.md` and `SPEC-qa.md` (edits noted above).

## Success criteria

1. **Every fetch is logged:** completing packing on a 2-package order with two fake providers creates two
   `RateFetch` rows (`ORDER`, `PACKING_COMPLETE`) whose quotes match the stored `ShippingRate`s one to one, and each
   `ShippingRate.quoteId` points at its quote.
2. **Nothing is lost:** a refresh replaces the working rates but the first fetch's rows are still there; the
   second fetch has trigger `REFRESH`. A package deleted in packing keeps its fetches with `packageId` null.
3. **Stale jobs write nothing:** a job whose generation was superseded logs no fetch.
4. **Failures logged:** every provider failing (after the final retry) logs one fetch with zero quotes and both
   errors; partial failure logs the survivors' quotes and the failed provider's error.
5. **Lane only:** a serialize-and-search test shows no name, street line or full postal code in `rate_fetches`;
   `destZip3` is the first three characters.
6. **Cheapest:** exactly one quote per fetch with any purchasable quote is `cheapest`, by the carriers tie rule;
   quote-only quotes are never `cheapest`; a fetch of only quote-only quotes has none.
7. **Fake flag:** quotes from the fakes have `fake = true`; a real adapter (ShipStation on fixtures) gives `false`.
8. **Reason:** selecting a non-cheapest rate with a reason stores it; a reason on the cheapest rate is refused;
   a note without `OTHER` is refused; selecting another rate clears it; `setRateSelectionReason` updates it.
9. **Purchase link:** a bought label has `rateQuoteId` of the selected rate's quote and its reason copied.
10. **Constraints:** the migration's check constraints reject a LAB fetch with an order id and a note without
    `OTHER` (tested against the DB).
11. **Permissions:** `qa.setRateSelectionReason` has allowed (QA) and forbidden (Packer) tests.
12. **E2E (desktop + tablet), fake providers:** QA picks the pricier fake rate, chooses "Faster delivery", buys the
    label; the order drawer shows the reason.
13. Green: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`, `migrate:check`, plus Playwright.

## Assumptions

1. Volume is small: tens of quotes per package, a few hundred packages a day at most. No partitioning.
2. Prices are USD; a quote in another currency is stored as-is and the dashboards filter on `USD`.
3. The carriers tie rule for "cheapest" stays the definition everywhere.

## Decisions (2026-11-03)

1. **Keep everything; compare against the purchase fetch.** Every fetch is logged; real-order "chosen vs.
   alternatives" uses the fetch the label was bought from.
2. **Reason for a pricier pick:** optional, from a fixed list, never blocking.
3. **Lane only:** the log stores country, state, first three postal characters and residential, never the address.
4. **No backfill:** V2 hasn't gone live.
5. **Kept forever** for now.
6. **Fake data is flagged** on every fetch and quote; dashboards hide it by default.
7. **Own module** (`rate-history`) rather than reopening `carriers`, which is `done`; it carries the small edits to
   `carriers` and `qa` listed above.

## Open questions

None.
