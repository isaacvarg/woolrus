# Spec: `qa`

**Milestone:** M4 · **Depends on:** `carriers` (rates per package, `ShippingProvider.purchaseLabel` / `findLabel` /
`voidLabel`, ship-to), `exceptions` (`openCriticalIssues`, `hasOpenCriticalIssue`, the report dialog), `workflow`
(QA → Ready, the **verified** gate, claims), `packing` (packages, `PackageItem`, the order drawer), `notes`
(storage adapter) · **Used by:** `shipping` (active labels with a stored PDF; reuses `voidLabel` for repack),
`returns` (the purchase job's pattern for return labels), `reporting` (label cost vs quote) · **State:** planned

Project-wide commands, structure, code style, testing levels and boundaries are in [`../../SPEC.md`](../../SPEC.md);
this spec only adds what is specific to `qa`.

## Objective

Give QA one tablet screen that turns a packed order into a Ready one: check every item in every box, pick the rate
per box, and buy the labels, without ever paying twice or losing track of a label that was paid for. This is where
Woolrus first spends real money (M4: "first real labels bought in Woolrus").

- **SRS:** FR-QA-01…07, NFR-REL-02 (record intent before a paid call, reconcile after), the QA half of FR-WF-04
  (who did QA and when), SRS §7.1 #5 (half-bought orders surfaced) and #15 (QA strings in the catalogs).
- **Users:** QA (`order.qa`, `label.purchase`, and now `label.void`) verifies, chooses rates, completes QA, voids a
  bought label in QA and settles a purchase whose outcome is unknown. Admins can do all of it and set the cost
  guard's thresholds (`settings.manage`). Everyone with `order.read` sees verification and label state on the
  order.
- **Why now:** `carriers` is done, so every package in QA has rates, and the **verified** gate already fails on
  `packageNotVerified` and `packageNoLabel` with no way to satisfy them.

### User stories

1. As QA, I open an order from the QA queue. It's claimed to me (as in picking and packing). I see each package with
   its items, the rates `carriers` fetched (cheapest selected) and the ship-to check.
2. I scan a jar. Package 1 counts one more verified unit of that line ("2 of 3"). A product that isn't in the package
   turns the screen red and says so ("not in this order", or "that's in package 2"), and nothing changes. An item
   without a barcode I tap to verify it in full; tapping a verified item clears it.
3. One line has an open **Critical** issue (crushed jar). Its row is marked "Critical issue" with an icon and the
   word, and **Complete QA** says why it can't run. I resolve the issue (or report one myself from the row) and the
   button comes back.
4. I prefer UPS Ground to the cheaper USPS rate on package 2, so I select it. A rate past its expiry can't be
   selected; I press **Refresh rates**.
5. Everything is verified, so I press **Complete QA**. The screen shows "Buying labels… 0 of 3" and I can open the
   next order. A few seconds later the order is in Ready with tracking numbers on each package.
6. Another time package 2's label is refused (the carrier doesn't offer that service for the box). Packages 1 and 3
   keep their labels; the order stays in QA, and the QA queue shows "Label failed". On the order: "2 of 3 labels
   bought. Package 2: UPS doesn't offer this service for this shipment." I pick another rate for package 2 and press
   **Complete QA** again: only package 2 is bought, and the order moves to Ready.
7. The drawer (FR-QA-04) shows who picked each item and who packed, the selected rate per package, and every order,
   item and package note.
8. As QA, I void package 1's label because the customer called to change the address. It's kept as `VOIDED` for
   history; package 1 can be rated and bought again.
9. An order's labels come to $38 but the customer paid $9.95 for shipping. Complete QA asks "Labels cost $38.00, the
   customer paid $9.95 for shipping. Buy anyway?" before buying anything. An admin sets when that question appears
   on **Settings → Shipping**.

## Scope

**In:**
- Per-item verification: tap (whole row) and scan (one unit), with a verified quantity per `PackageItem`.
- Rate selection per package.
- **Complete QA**: preconditions checked in the request, `PURCHASING` label rows recorded in the same transaction,
  and a `labels.purchase` job that buys them, copies each PDF into our storage, and moves the order to Ready.
- Keep-and-retry on partial failure (FR-QA-07): bought labels stay, a retry buys only what's missing.
- Reconciling labels whose purchase outcome is unknown (NFR-REL-02): lookup by idempotency key where the provider
  can, a manual settle where it can't, and a sweep for jobs that died.
- Blocking on open critical issues (FR-QA-05/06): flagged per row, refused at purchase, and a new condition on the
  **verified** gate.
- `voidLabel` for an active label on an order in QA (QA and Admin). `shipping` reuses it for repack.
- The cost guard: Complete QA asks for confirmation when the labels cost far more than the customer paid for
  shipping, with thresholds in Settings.
- The QA screen `/qa/[orderId]`, the QA queue's label badge, and label state on the order detail page.
- Schema additions listed below (ask-first: approved with this spec).

**Out (owned elsewhere or later):**
- Printing, reprinting and the merged PDF (FR-SHIP-05/11), shipping, the Woo push, repack, manifests, customs data
  (FR-SHIP-13): `shipping`. International shipping isn't needed for go-live (decision 8): admins leave
  international services off, and a refused international purchase fails like any other refusal.
- Settling a `VOID_REJECTED` label (it stays live and blocks its package): `shipping`, with its repack flow.
- Shipping rules that pick a service automatically (SRS §7.2 #7): later; cheapest stays the default.
- Requiring a scan before an item counts (tap stays allowed, as in picking).
- Return labels: `returns`.

## Design

### Verification (`packages/core/src/qa/verify.ts`, FR-QA-01)

`PackageItem` gains `qaVerifiedQuantity` (0…`quantity`). `qaVerifiedAt/ById` are set when it reaches `quantity`
and cleared when it drops below, so the **verified** gate keeps reading `qaVerifiedAt`. A package is verified when
all its rows are; voided units are already out of the package (exceptions unpacks them).

| Function | Permission | Rule |
|---|---|---|
| `setVerified({ packageItemId, verified, idempotencyKey })` | `order.qa` | Tap. `true` sets the row to its full quantity, `false` to 0. Order in QA, actor holds the claim, no label of the order `PURCHASING`. Audited `packageItem.verify` / `unverify`. |
| `scanVerify({ orderId, packageId, code, scanId })` | `order.qa` | Resolves the code with picking's matching (`normalizeCode`, `matchingLines`: variation SKU, product SKU, line SKU and linked barcodes) against the lines in **this** package, and adds one unit to the first row that still needs it. Idempotent on `scanId`. |

Scan refusals throw and change nothing: `errors.qa.scanNotOnOrder` (with the scan-to-link offer for
`product.manage`, as in picking), `errors.qa.scanOtherPackage` (`{ package }`: the code matches a row in another
package), `errors.qa.scanAlreadyVerified` (every matching row is complete). The screen turns red for the first two
and amber for the third.

`packing` clears verification on a content change today (`qaVerifiedAt/ById`); it now also zeroes
`qaVerifiedQuantity` (edit to `packing/service.ts`).

### Rate selection (`packages/core/src/qa/rates.ts`, FR-QA-02)

`selectRate({ packageId, rateId })` (`order.qa`, claim held, order in QA): the rate must belong to the package and
not be expired (`errors.qa.rateExpired`), and the package must have no live label (`errors.qa.packageHasLabel`).
Unselects the old rate and selects the new one in one statement order that keeps the one-selected-per-package index
happy (unselect first). Audited `rate.select` with both rate ids and amounts.

Refresh stays `carriers.refreshRates`, with one change (edit to SPEC-carriers): it refreshes the packages **without**
a live label and leaves the others' rates alone, so a partly bought order can re-rate the failed package. It is
refused only while a label of the order is `PURCHASING`, or when every package has a live label. The `rates.fetch`
job skips packages that have a live label by the time it writes. `recheckAddress` and `keepOriginalAddress` are
refused while any package has a live label (`errors.qa.addressLockedByLabel`): bought labels carry the old address.

### Critical issues (FR-QA-05/06)

- **Flag:** the QA screen read marks a row when an open critical issue names its line (`orderItemId`) or its
  package; one that names neither puts a banner on the order. Built on `openCriticalIssues(tx, orderId)`.
- **Gate:** the **verified** gate gains `criticalIssueOpen` (`{ count }`), from `hasOpenCriticalIssue` read in
  `loadGateSnapshot` (edit to SPEC-workflow and `workflow/gates.ts`). So no path to Ready, the API included, skips
  it; `forceStatus` still skips gates for admins, as today.
- **Purchase:** Complete QA refuses to start buying while one is open, so no money is spent on an order that can't
  leave QA. An issue reported while the job runs doesn't stop labels already in flight; the job's final move fails
  the gate, the order stays in QA with its labels, and Complete QA moves it once the issue is resolved.

### Complete QA (`packages/core/src/qa/complete.ts`, FR-QA-03/07)

`completeQa({ orderId, expectedVersion })` (`order.qa` + `label.purchase`) replaces the handler of the existing
`orders.completeQa` route (`POST /orders/{id}/complete-qa`), so there is one way in. In one transaction, under the
order lock:

1. Order in QA, version matches (`errors.workflow.stale`), actor holds a live claim.
2. **Preconditions** (`purchasePreconditions`, pure, also shown on the screen): the **verified** gate minus its
   `packageNoLabel` condition, plus: no label `PURCHASING` (`errors.qa.purchaseInProgress`), every selected rate
   unexpired (`rateExpired { package }`), every package's provider enabled (`providerOff { package }`). Unmet →
   `CONFLICT errors.workflow.gateFailed` with the list, as transitions do.
3. If every package already has an `ACTIVE` label with a stored PDF, run the QA → Ready transition now and return
   (the retry after a failed final move).
4. Otherwise, for each package without a live label, insert a `ShippingLabel`: `PURCHASING`, a fresh UUIDv7
   `idempotencyKey`, `provider`, `carrierId`, `serviceId`, codes and `quotedAmountCents` from the selected rate,
   `purchasedById` = actor. Earlier `PURCHASE_FAILED` rows stay as history. The one-live-label index makes a double
   submit impossible even if two requests got past step 2.
5. Bump `Order.version`, refresh the claim (`claimedAt = now`), audit `labels.purchaseRequested` with the package
   numbers, enqueue `labels.purchase { orderId, requestedById }` (singleton per order), `notifyOrderChanged`.

The request returns the order; the screen follows the job through live updates. Target: under 300 ms.

### Cost guard (`packages/core/src/qa/cost-guard.ts`)

Two settings on the `Settings` row, edited on **Settings → Shipping** (`settings.manage`, through `updateSettings`,
audited like the other fields):

| Setting | Default | Meaning |
|---|---|---|
| `labelCostConfirmRatio` | `2.0` | Ask when the labels cost more than this many times what the customer paid for shipping. Empty turns the check off. |
| `labelCostConfirmFreeCents` | `1500` ($15) | For orders where the customer paid nothing for shipping (`shippingChargedCents = 0`), ask when the labels cost more than this. Empty turns the check off. |

`labelCost` = the sum of the selected rates' amounts across every package (labels already `ACTIVE` count at their
`costCents`). It's checked in step 2 of Complete QA, after the other preconditions, by a pure function
(`needsCostConfirmation(labelCost, chargedCents, settings)`). When it trips and the input lacks
`confirmCost: true`, the request fails with `CONFLICT errors.qa.costConfirmRequired`
(`{ labelCostCents, chargedCents }`) and writes nothing. The screen shows the confirmation and resends with
`confirmCost: true`. The audit row `labels.purchaseRequested` records `costConfirmed` and both amounts. A retry
after a partial failure checks again (the new rate may cost more). Step 3's "only move the order" path never asks.

### The `labels.purchase` job (`packages/core/src/qa/purchase.ts`)

Retry policy `{ retryLimit: 4, retryDelay: 15, retryBackoff: true }`. Each label is handled on its own, all of the
order's labels in parallel, each provider call bounded by `PURCHASE_TIMEOUT_MS` (30 s, a constant):

1. **Rate:** the package's selected rate. Missing or expired → `PURCHASE_FAILED` (`rateExpired`), no call.
2. **Lost response first:** if `purchaseAttemptedAt` is set, an earlier attempt may have bought it.
   - Provider has `labelLookup` → `findLabel(idempotencyKey)`. Found → record it (step 4). Not found → buy (step 3).
   - Provider can't look up (Bridge Source until proven) → never buy again: the label stays `PURCHASING` with
     `error = errors.qa.purchaseUnknown`, and a person with `label.void` settles it (below).
3. **Buy:** write `purchaseAttemptedAt = now` in its own committed transaction (the intent, NFR-REL-02), then
   `purchaseLabel` with the shipment rebuilt from the package, `Order.shipTo` and Settings' ship-from, the label's
   `idempotencyKey`, reference = order number, 4×6 PDF.
4. **Bought:** one transaction: `ACTIVE`, provider label and shipment ids, tracking, `costCents`, currency,
   `shipDate`, `purchasedAt`, `pdfUrl` when given; audit `label.purchase`. Then copy the PDF (from the URL, or the
   bytes Bridge Source returns) to storage at `labels/<labelId>.pdf` and set `storageKey`. A failed copy throws, and
   the retry finds the label `ACTIVE` without `storageKey` and only copies.
5. **Refused** (`ShippingError` with `permanent`): `PURCHASE_FAILED`, `error` = its message key (`notOffered`,
   `addressRejected`, `rejected`, `unauthorized`). No retry for that label.
6. **Transient** (`unavailable`, `timeout`): stays `PURCHASING`. After every label settles, the job throws so pg-boss
   retries; retries start at step 2. On the final attempt, a label still unresolved is `PURCHASE_FAILED` only if the
   provider's `findLabel` says it doesn't exist; otherwise it stays `PURCHASING` with `purchaseUnknown`.

**Final move:** when every package has an `ACTIVE` label with `storageKey`, the job runs the QA → Ready transition
**as the requesting user** (re-read: still active, still has `order.qa`). It needs the order still in QA and the
claim still that user's; claim *expiry* is ignored for this move only, since the claim was refreshed when the job
started (a `TransitionOptions` flag, edit to SPEC-workflow). The gate runs as usual. If the move can't happen
(taken over, held, critical issue, stale) the labels stay and the next **Complete QA** just moves the order (step 3
of Complete QA). Every label write calls `notifyOrderChanged`.

**Sweep** (`labels.reconcile`, every 10 minutes and at worker start): enqueues `labels.purchase` for any order with a
`PURCHASING` label created more than 10 minutes ago and no job queued, so a worker that died mid-purchase is
reconciled. Labels marked `purchaseUnknown` are skipped; they wait for a person.

### Settling and voiding (`packages/core/src/qa/labels.ts`)

| Function | Permission | Rule |
|---|---|---|
| `markLabelNotBought({ labelId, reason })` | `label.void` | Only a `PURCHASING` label with `purchaseUnknown`. The user has checked the provider's site and found no label, or voided it there. → `PURCHASE_FAILED`, `error = errors.qa.settledManually`, reason audited. The package can be bought again. |
| `voidLabel({ labelId, reason })` | `label.void` | An `ACTIVE` label of an order in QA (`shipping` widens this to Ready and repack). Provider must have `void`. Writes `VOID_REQUESTED` + `voidRequestedAt`, `voidedById`, `voidReason` and commits, then calls `voidLabel`: approved → `VOIDED`, `voidedAt`; `approved: false` → `VOID_REJECTED` with the provider's code (SRS §7.1 #6); transient → stays `VOID_REQUESTED`, the call can be repeated. The row is never deleted. Audited. |

### Reads

- `qa.screen({ orderId })` (`order.read`): per package: number, box, weight, rows (line name, SKU, image, variation,
  quantity, `qaVerifiedQuantity`, verified by/at, `criticalIssue` flag with issue id), the label (status, tracking,
  carrier label or name, service, cost vs quote, error key, purchased by/at) and earlier failed attempts; the
  order-level critical banner; `purchase`: `idle | purchasing { bought, total } | failed { packages }`; and
  `purchasePreconditions` as unmet conditions. Rates and ship-to come from `carriers.orderShipping`, which gains
  the package's live label.
- The drawer (FR-QA-04) reuses packing's order drawer, adding the selected rate per package and QA verification.
- QA queue rows gain `labelState`: `none | purchasing | failed | unknown`, from one grouped subquery in the existing
  queue query (the 2,000-order benchmark must still pass).

### API (oRPC, `packages/contracts/src/qa.ts`)

| Procedure | Route |
|---|---|
| `qa.screen` | `GET /orders/{orderId}/qa` |
| `qa.setVerified` | `POST /package-items/{packageItemId}/verified` |
| `qa.scan` | `POST /orders/{orderId}/qa/scan` |
| `qa.selectRate` | `POST /packages/{packageId}/selected-rate` |
| `orders.completeQa` (handler replaced) | `POST /orders/{id}/complete-qa` |
| `qa.voidLabel` | `POST /labels/{labelId}/void` |
| `qa.markLabelNotBought` | `POST /labels/{labelId}/not-bought` |

Error keys live under `errors.qa.*`; no literal English (SRS §7.1 #15).

### Schema additions (ask-first: listed here for approval)

One migration, no new tables, no new permissions:
- `PackageItem.qaVerifiedQuantity Int @default(0) @map("qa_verified_quantity")`, with a hand-written
  `CHECK (qa_verified_quantity BETWEEN 0 AND quantity)`. Existing rows with `qaVerifiedAt` get `quantity`.
- `ShippingLabel`: `purchaseAttemptedAt DateTime?` (the intent marker), `carrierId` and `serviceId` (nullable FKs,
  Restrict, so reporting and voids know the exact account), `quotedAmountCents Int?`. `error` holds a message key
  (comment only).
- `Settings.labelCostConfirmRatio Decimal? @default(2.0) @db.Decimal(6, 2)` and
  `Settings.labelCostConfirmFreeCents Int? @default(1500)`, with a hand-written check that each is positive when set.
- Queues `labels.purchase` and `labels.reconcile` in `jobs.ts`.
- **Permission grant** (`core/src/permissions.ts`): the QA role gains `label.void` (decision 7). Shipper doesn't.

The init migration's hand-written constraints stay, in particular one live label per package (`PURCHASING` counts
as live) and one selected rate per package.

### UI (`apps/web/src/app/(app)/qa/[orderId]/`)

- Tablet first, like `pack/[orderId]`: a card per package with its rows (tap target, "2 of 3 verified", the
  critical flag as icon + word, **Report issue** from exceptions' dialog), the rates table from `carriers` with
  selection, and the label state once bought. A scanner in HID mode scans into the focused package (the package
  card the user last touched; the first unverified one by default), using picking's keyboard listener.
- Footer: **Complete QA** with the unmet preconditions listed under it; while buying, "Buying labels… 1 of 3" and
  **Next order**; after a failure, a banner per failed package with its reason and what to do (pick another rate,
  refresh, fix the address).
- On a bought label, for `label.void`: **Void label** (confirm, reason). On a `purchaseUnknown` label: "Check
  <provider> for a label with reference <order number>" and **Mark not bought** (confirm, reason).
- The cost confirmation dialog: label cost, shipping charged, **Buy anyway** / **Cancel**.
- **Settings → Shipping** gains a "Label cost check" card with the two thresholds (ratio as "×", amount in dollars;
  empty = off).
- QA queue: a badge for `purchasing`, `failed` and `unknown` (text, not colour alone). Order detail: label state per
  package, read-only.
- All strings in `en` and `es`.

### Dev data

The fake providers' `purchaseLabel` gets deterministic failures for e2e and dev: a ship-to line 2 containing
`FAIL-BUY-<n>` refuses package `n` with `notOffered`; `SLOW-BUY` delays every purchase past the timeout once, then
succeeds (proving the lookup path). The fakes return a one-page PDF. `pnpm db:seed`'s demo QA orders get one
ordinary order and one with `FAIL-BUY-2`.

### Files expected to change

`packages/core/src/qa/{verify,rates,complete,cost-guard,purchase,labels,queries}.ts` (+ tests),
`packages/core/src/{permissions,settings/service}.ts`, `packages/core/src/workflow/
{gates,service,queries}.ts`, `packages/core/src/carriers/{rates,ship-to}.ts`, `packages/core/src/packing/service.ts`,
`packages/core/src/adapters/shipping/fake.ts`, `packages/core/src/{jobs,index}.ts`, `packages/core/test/factories.ts`,
`apps/worker/src/**` (two handlers, sweep schedule), `packages/contracts/src/{qa,orders,carriers,index}.ts`,
`packages/contracts/src/settings.ts`, `apps/web/src/server/router.ts`,
`apps/web/src/app/(app)/{qa/**,queue/**,orders/[id]/**,settings/shipping/**}`,
`packages/db/prisma/schema/{shipping,system}.prisma` + one migration, `packages/db/prisma/seed-orders.ts`,
`packages/i18n/src/messages/{en,es}.json`, `apps/web/e2e/qa.spec.ts`, and the edits to `SPEC-workflow.md` and
`SPEC-carriers.md` named above.

## Success criteria

1. **Verify:** tapping sets a row verified in full and clears it again; a scan adds exactly one unit to the right
   row in the focused package; `qaVerifiedAt` is set exactly when the quantity is complete; a replayed `scanId`
   counts once; each refusal (not on order, other package, already verified) changes and audits nothing.
2. **Invalidation:** a packing change after a repack zeroes verification on that package's rows.
3. **Rate choice:** selecting another rate leaves exactly one selected; an expired rate, a rate from another
   package, or a package with a live label is refused.
4. **Critical issues:** an open critical issue flags its row (or the order banner), blocks Complete QA before any
   label row is written, and makes the **verified** gate fail with `criticalIssueOpen` through `/api/v1` too.
5. **Preconditions:** each unmet one (unverified row, no selected rate, expired rate, provider off, purchase in
   progress) refuses Complete QA with that condition and writes nothing.
6. **Intent first:** Complete QA writes one `PURCHASING` label per package without one and enqueues exactly one job
   in the same transaction; a rolled-back request leaves neither. Two concurrent requests buy once.
7. **Happy path:** with fake providers, the job buys every label, stores tracking, cost and the PDF in storage, and
   moves the order to Ready as the requesting user (stage event and audit name them).
8. **Partial failure (FR-QA-07):** package 2 refused → packages 1 and 3 `ACTIVE`, package 2 `PURCHASE_FAILED` with
   `notOffered`, order in QA, queue badge `failed`. After choosing another rate, Complete QA buys only package 2
   (one provider call) and the order reaches Ready.
9. **Lost response:** a timeout after the provider bought the label → the retry finds it with `findLabel` and
   records it without a second purchase (the fake counts purchases: exactly one). A provider without lookup leaves
   it `PURCHASING` + `purchaseUnknown`, never buys again, and **Mark not bought** releases it.
10. **Crash:** a label `PURCHASING` for over 10 minutes with no job is picked up by the sweep and settled.
11. **Storage:** a failed PDF copy leaves the label `ACTIVE`, the order in QA, and the retry copies without buying.
12. **Final move:** a takeover, hold or critical issue during the job leaves the order in QA with its labels; the
    next Complete QA moves it without calling a provider.
13. **Void:** approved → `VOIDED` and the package can be bought again; `approved: false` → `VOID_REJECTED`, still
    live; no label row is ever deleted.
14. **Refresh:** on a partly bought order, refresh re-rates only packages without a live label; address re-check is
    refused while a label is live.
15. **Permissions:** every procedure has an allowed and a forbidden test (a Packer can't verify; a Shipper can't
    complete QA or void; QA can void and mark not bought; only `settings.manage` changes the cost thresholds;
    anyone can read the screen).
16. **Cost guard:** as a pure function, the ratio check, the free-shipping amount check and each one turned off; in
    the service, a tripped guard without `confirmCost` writes nothing and returns both amounts, with it the
    purchase starts and the audit records the confirmation; a retry with a dearer rate asks again.
17. **Performance:** Complete QA returns in under 300 ms p95; with fakes at 2 s latency, a 3-package order is Ready
    in under 5 s (parallel); `qa.screen` under 300 ms p95 for 5 packages × 10 rows.
18. **E2E (desktop + tablet), fake providers:** a QA user opens an order, scans and taps every item, changes one
    rate, completes QA, and sees it in Ready with tracking; a `FAIL-BUY-2` order shows the failure, a new rate, a
    second Complete QA, Ready; an open critical issue hides nothing but blocks the button with its reason; an order
    over the cost threshold asks before buying.
19. **No live purchase in tests.** The opt-in live test of a real ShipStation label purchase is not written without
    asking first (SPEC.md boundary). Green: `pnpm lint && pnpm typecheck && pnpm test && pnpm build` plus Playwright.

## Assumptions

1. A QA user often moves to the next order while labels are bought; nothing needs them to wait on the screen.
2. Label cost can differ from the quote (surcharges, reweighs); both are stored and shown, never blocked on.
3. Rate selection is manual; nothing chooses a service by rules yet.
4. Ship-from is US and currency USD (carriers' assumption). Every go-live order ships domestically.
5. ShipStation's `findLabel` by our reference is reliable (proven in `carriers`' fixtures). Bridge Source's isn't
   proven yet, so its lost responses are settled by hand.
6. A label bought for a package is valid only for that package's box, weight and address; QA can't change those
   in QA, and the address is locked once a label is live.

## Decisions (2026-10-28)

1. **Labels are bought by a background job** (`labels.purchase`), not in the request. Complete QA records the
   intent and returns; the job buys, stores and moves the order to Ready.
2. **Partial failure keeps and retries:** bought labels stay `ACTIVE`; a retry buys only what's missing. Nothing is
   voided automatically.
3. **Verification is tap or scan,** one unit per scan, with a verified quantity per package row.
4. **One button:** Complete QA buys the labels and completes QA; pressed again after labels are bought, it only
   moves the order.
5. **Open critical issues block both the purchase and the gate**, so no money is spent on an order that can't leave
   QA.
6. **No second purchase without proof:** a label whose first attempt's fate is unknown is bought again only after
   the provider's lookup says it doesn't exist; otherwise a person settles it.
7. **QA can void labels** in QA: the QA role gets `label.void` (it settles unknown purchases with the same
   permission).
8. **No international shipping for go-live,** so customs (FR-SHIP-13) stays in `shipping` and isn't pulled forward.
9. **Cost guard with configurable thresholds:** Complete QA asks before buying labels that cost more than
   `labelCostConfirmRatio` × the shipping the customer paid (default 2×), or more than `labelCostConfirmFreeCents`
   when they paid nothing (default $15). Either check can be turned off in Settings → Shipping.

## Open questions

None. The three raised in the draft were settled on 2026-10-28 (decisions 7–9).
