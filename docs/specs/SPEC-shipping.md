# Spec: `shipping`

**Milestone:** M4 · **Depends on:** `qa` (orders reach Ready with one `ACTIVE` label per package and its PDF in
storage; `voidLabel`), `store-sync` (the WooCommerce adapter, which this module adds write methods to), `carriers`
(the `ShippingProvider` seam, carriers and services, the shipment built for rates and purchase), `workflow`
(`ship`, `repack`, the **shippable** gate), `notes` (`notesToPush`, `markNotePushed`), `exceptions`
(`linkIssueToRepack`), `packing` (packages) · **Used by:** `returns` (shipped orders, the label print path),
`reporting` (shipped orders, label spend, manifests), `operations` (WooCommerce health gains the tracking check) ·
**Issue:** [#28](https://github.com/isaacvarg/woolrus/issues/28) · **State:** spec approved

Project-wide commands, structure, code style, testing levels and boundaries are in [`../../SPEC.md`](../../SPEC.md);
this spec only adds what is specific to `shipping`.

## Objective

Get a Ready order out of the door and tell WooCommerce: print its labels (as often as needed), mark it shipped,
push Completed with tracking and notes to the store until it sticks, send it back to packing safely when
something's wrong, hand the carrier its end-of-day manifest, and carry customs data for international parcels.
This is the last step of the go-live journey (SPEC.md go-live checklist: "Woo shows Completed + tracking").

- **SRS:** FR-SHIP-05…08, FR-SHIP-10, FR-SHIP-11, FR-SHIP-13, FR-SHIP-14; the completion half of FR-WF-04;
  §7.1 #2 (label merge without auth), #6 (repack ignoring a rejected void), #7 (ship without Ready), #8 (notes
  posted twice or with author names to the customer), #12 (tracking sent as "ShipStation", numbers comma-joined).
  Already done elsewhere: FR-SHIP-04 (`qa`), FR-SHIP-09 (`settings`; one warehouse per decisions.md), FR-SHIP-12
  (`carriers`).
- **Users:** Shippers (`order.ship`, `label.print`, and now `order.repack`) work the Ready queue at the packing
  bench: print, ship, repack, manifests. QA prints and repacks too. Admins do everything, settle labels a provider
  won't void, edit customs data and work the WooCommerce push errors list.
- **Why now:** `qa` is done, so orders sit in Ready with paid labels and nothing can ship them.

### User stories

1. As a Shipper, I open the **Ready** queue. Each row shows packages, carrier and service, and "Not printed" or
   "Printed 2×". I tick five orders and press **Print labels**: one PDF with every label of those orders, in
   queue order then package order, opens in a new tab. Nothing else changes.
2. The printer jammed on the third label. I open that order and press **Reprint** on package 2 alone. It prints
   again; the order is still in Ready.
3. I tick the five orders and press **Ship**. They leave the queue as Completed. One of them was never printed, so
   Ship first asks "1 order's labels were never printed. Ship anyway?".
4. A minute later each order in WooCommerce is Completed, has one tracking item per package (UPS with its tracking
   link, USPS with its own), shows the customer note I wrote, and has our internal notes as private notes with the
   author's name. The customer's Completed email includes the tracking numbers.
   Until IT has installed the AST plugin, tracking is switched off in Settings: the order still goes Completed with
   its notes, and the tracking numbers go to the customer as one customer note instead.
5. The store was down when I shipped. The orders are Completed in Woolrus and show "Woo update pending"; the
   worker retries, and they turn "Sent to Woo" when the store is back. If it never works, an admin sees them
   under **Sync → Push errors** with the reason and presses **Retry**.
6. A customer calls about the wrong scent while the order sits in Ready. I select it and press **Repack**, pick
   the reason and, optionally, the quality issue behind it, and confirm. Its labels are voided at the provider,
   kept as `VOIDED`, and the order is back in Packing with its boxes as they were but unverified and unrated.
7. Another time the provider refuses one void. The order stays in Ready and says "Package 2: UPS refused the void
   (already in transit?)". I can retry the void; an admin who has checked the carrier can mark the label
   **Written off** with a reason, which frees the package, and the repack goes through.
8. At 4 pm I open **Manifests**, see today's shipped labels grouped by carrier account ("USPS · 23 labels not
   manifested"), press **Create manifest** for USPS and print the SCAN form for the driver.
9. As an admin, I fill in HS code, country of origin and customs description for our products on **Settings →
   Customs** (a list that shows which products are missing them). An order to Canada then gets rates and labels
   with a customs declaration built from its lines; one with a product missing an HS code says which product,
   before any rate is fetched.

## Scope

**In:**
- **Print** (FR-SHIP-11): a merged 4×6 PDF of the selected orders' active labels (or one label), served by the app
  with an auth check per request, counted per label (`printCount`, `lastPrintedAt`), never changing status.
- **Ship** (FR-SHIP-05): batch Ready → Completed through the **shippable** gate, warning about unprinted labels.
- **WooCommerce push** (FR-SHIP-06/07/10): a `woo.push` job per shipped order that adds a tracking item per label
  through the Advanced Shipment Tracking (AST) plugin when tracking is switched on (a customer note with the
  numbers when it's off), posts unposted notes per the notes contract, then sets Completed; idempotent on retry,
  recorded on the order, retried automatically, listed for admins with a manual retry.
- **Tracking switch:** `Settings.wooTrackingEnabled`, off by default, so shipping doesn't wait for the plugin.
- **Repack** (FR-SHIP-08): void every live label at its provider, keep the rows, return to Packing; rejected voids
  stop the repack and can be retried or written off by an admin.
- **Manifests** (FR-SHIP-14): per carrier account and ship date, through providers with the `manifests`
  capability; the PDF is stored and printable.
- **Customs** (FR-SHIP-13): per-product customs fields with an admin editor, a customs declaration built per
  package and sent with rates and purchases for international ship-tos, and a precondition when data is missing.
- Schema, permission and dependency additions listed below (ask-first: approved with this spec).

**Out (owned elsewhere or later):**
- Shipping rules that pick a service automatically (SRS §7.2 #7), packing slips (§7.2 #12): later.
- Return labels and RMA: `returns`.
- Bridge Source booking, void and manifests: `bridge-source` stage 2. Until then its `manifests` capability is
  false and it never holds a label.
- Customer shipping notifications beyond WooCommerce's own Completed email (§7.2 #11).
- Customs for Bridge Source (no booking yet) and for return labels.
- Installing or configuring AST in the production store: IT installs it, then an admin switches tracking on.
- Back-filling tracking items for orders shipped while tracking was off.

## Design

### Print (`packages/core/src/shipping/print.ts`, FR-SHIP-11, §7.1 #2)

Two steps, so a GET that streams a PDF never has side effects and a prefetch can't count a print:

| Function | Permission | Rule |
|---|---|---|
| `createLabelPrint({ orderIds?, labelIds?, idempotencyKey })` | `label.print` | Exactly one of the two lists (1–50 orders or 1–20 labels). Orders must be `READY` or `COMPLETED`; labels must be `ACTIVE` with `storageKey` and belong to such an order. Every `ACTIVE` label of each order is included (`orderIds`), in the given order then package number. Inserts a `LabelPrint` (who, when, which labels, in order), bumps each label's `printCount` and `lastPrintedAt`, audits `label.print` per order. Returns `{ printId, labelCount }`. Idempotent. |
| `GET /api/label-prints/{printId}.pdf` (route handler, not oRPC) | `label.print`, and the print is the actor's | Merges the stored PDFs in order with `pdf-lib` and streams `application/pdf`, `Content-Disposition: inline`, `Cache-Control: private, no-store`, `nosniff`. 404 for someone else's print or one older than 24 h. |

The web app opens the GET in a new tab right after `createLabelPrint` returns. Prints are allowed on Completed
orders too, so a misprint found after shipping can still be reprinted. Each stored PDF is one 4×6 page (as `qa`
buys them); the merge copies pages as they are.

### Ship (`packages/core/src/shipping/ship.ts`, FR-SHIP-05, §7.1 #7)

`shipOrders({ orderIds, confirmUnprinted, idempotencyKey })` (`order.ship`, 1–50 orders):

1. **Unprinted check first** (one read): if any order has an `ACTIVE` label with `printCount = 0` and
   `confirmUnprinted` isn't `true`, fail with `CONFLICT errors.shipping.unprintedLabels` (`{ orderNumbers }`) and
   write nothing. The UI confirms and resends.
2. **Per order, its own transaction** (one order failing doesn't stop the rest): `workflow.ship` (Ready, version
   bump, **shippable** gate, stage event, `completedAt`), `wooPushStatus = PENDING`, `wooPushAttempts = 0`,
   `wooPushError = null`, enqueue `woo.push { orderId }` on the same transaction (singleton per order), audit
   `order.ship`, `notifyOrderChanged`.
3. Returns `{ results: { orderId, orderNumber, ok: true } | { orderId, orderNumber, ok: false, messageKey,
   params } }[]`. The UI says "4 shipped, 1 couldn't: #1043 is no longer Ready".

No claim is needed (workflow: shipping works in batches); an order someone else holds a claim on still ships, and
the claim is cleared by the transition as today. Idempotent: a replay returns the stored results.

### WooCommerce push (`packages/core/src/shipping/woo-push.ts`, FR-SHIP-06/07/10, §7.1 #8, #12)

**Tracking goes through the Advanced Shipment Tracking plugin** (AST by zorem, free on wordpress.org;
decision 1): its REST namespace `/wp-json/wc-shipment-tracking/v3` (the same routes the paid WooCommerce
Shipment Tracking extension uses), `POST /orders/{id}/shipment-trackings` with `tracking_number`,
`date_shipped` and either `tracking_provider` (a provider AST knows, e.g. "USPS", "UPS", "FedEx") or a custom
provider. Each item has its own `tracking_id`. WooCommerce shows them on the customer's order page and in the
Completed email. Paths, field names, the provider list and which features are free vs AST Pro are **verified
against zorem's current docs** when the ticket is built, and the fixtures are recorded from the dev WooCommerce
running the real free plugin, then scrubbed.

**Tracking switch** (`Settings.wooTrackingEnabled`, default `false`, decision 9): edited on **Settings →
Integrations → WooCommerce** (`settings.manage`, through `updateSettings`, audited). Switching it **on** first calls
`hasShipmentTracking()` and is refused with `errors.settings.trackingPluginMissing` when the store doesn't have the
route, so it can't be turned on before IT has installed the plugin. Switching it off is always allowed. The job
reads the setting when it reaches the tracking step, so orders already pushed are left as they are and nothing is
back-filled.

**Store adapter additions** (`adapters/woocommerce/`, REST v3 + AST's namespace, same basic auth):

| Method | Call |
|---|---|
| `hasShipmentTracking()` | `GET /wp-json/wc-shipment-tracking/v3` → true on 2xx, false on 404 `rest_no_route` |
| `listShipmentTrackings(orderId)` | `GET …/orders/{id}/shipment-trackings` |
| `addShipmentTracking(orderId, item)` | `POST …/orders/{id}/shipment-trackings` → `{ trackingId }` |
| `listOrderNotes(orderId)` | `GET /wc/v3/orders/{id}/notes` |
| `addOrderNote(orderId, { note, customerNote })` | `POST /wc/v3/orders/{id}/notes` → `{ noteId }` |
| `completeOrder(orderId)` | `PUT /wc/v3/orders/{id}` with `{ status: "completed" }` |

`StoreError` gains the kind `trackingUnavailable` (AST's route is missing; permanent). The fake store
adapter implements all six, with a switch to turn the plugin off and `failNext` as today.

**Carrier → tracking provider** (`shipping/tracking-provider.ts`, pure): a constant table from our carrier code
(`ShippingLabel.carrierCode`, e.g. `usps`, `ups`, `fedex`, `dhl_express`) to AST's provider name. A
carrier not in the table goes as a custom provider named after the carrier's display name (`label` or `name`),
with a tracking link template when the table has one and none otherwise. Never "ShipStation" (§7.1 #12).

**The job** (`woo.push { orderId }`, retry policy `{ retryLimit: 8, retryDelay: 60, retryBackoff: true }`, about
4 hours in all). Runs as the system actor `shipping` (audit rows show "Shipping", like store-sync's actor). Each
step is idempotent, so a retry from the top never repeats a write that succeeded:

1. Load the order (must be `COMPLETED`, `wooPushStatus` `PENDING` or `FAILED` when retried by hand; else return),
   its `ACTIVE` labels in package order, bump `wooPushAttempts`.
2. **Tracking first**, so the Completed email carries it:
   - **Switch on:** list the order's tracking items once; for each label without `wooTrackingId`, reuse an item
     with the same tracking number if there is one (a lost response), otherwise add it. Store `wooTrackingId` on
     the label in its own transaction after each call. One item per label: never comma-joined.
   - **Switch off:** unless `Order.wooTrackingNoteId` is set, post one customer note ("Your order has shipped:
     Package 1 — UPS 1Z…, <link>; Package 2 — …", translated to the order's language when known, else `en`),
     matched against the order's notes first like step 3, and store its id in `Order.wooTrackingNoteId`. So the
     customer still gets every number, one line per label, while the plugin isn't there.
3. **Notes:** `notesToPush(tx, orderId)`, oldest first, formatted per the notes contract (customer note: content
   only; internal: private, `[Author · Target]` prefix, attachment count). List the order's notes once; skip a post
   when a note with the same text and `customer_note` flag already exists (a lost response); `markNotePushed` after
   each post.
4. **Status:** `completeOrder` (Woo treats a repeat as a no-op). Store-sync's change detection already counts the
   resulting `completed` as the store catching up.
5. **Done:** `wooPushStatus = SUCCEEDED`, `wooPushedAt`, `wooPushError = null`, audit `woo.push`,
   `notifyOrderChanged`.

**Failures** (FR-SHIP-07: the local Completed is never undone):
- Transient (`unavailable`, `timeout`, 5xx): record `wooPushError` (the message key) and throw so pg-boss retries.
  The order shows "Woo update pending" with the last error.
- Permanent (`unauthorized`, `notFound`, `rejected`, `trackingUnavailable`) or retries exhausted:
  `wooPushStatus = FAILED`, `wooPushError` set, audit `woo.push.failed`. No more automatic retries.

**Push errors view** (FR-SHIP-10): **Sync → Push errors** (`settings.manage`) lists orders with `wooPushStatus`
`FAILED` or `PENDING` for over 15 minutes: order, error, attempts, last try, link to the order. `retryWooPush({
orderIds })` (`settings.manage`, 1–50) sets them `PENDING` and re-enqueues. The order detail page shows the push
state to everyone with `order.read`, and the same **Retry** for admins.

**Health and Test connection:** **Settings → Integrations → Test connection** also calls `hasShipmentTracking()`
and says whether AST is there, whatever the switch. With the switch on, the WooCommerce health check calls it too,
and without the route reports `woocommerce: degraded` (`trackingUnavailable`); with it off, health doesn't check
(edit to SPEC-operations). Tracking off is not a go-live blocker; turning it on is a follow-up once IT is done.

### Repack (`packages/core/src/shipping/repack.ts`, FR-SHIP-08, §7.1 #6)

`repackOrders({ orderIds, reason, issueId?, idempotencyKey })` (`order.repack`, 1–10 orders; `issueId` only with
one order). Per order, in parallel across orders:

1. Order is `READY` (`errors.workflow.illegalTransition` otherwise).
2. **Void every live label** with `qa`'s `voidLabel` flow, widened to `READY` orders and `order.repack`
   (decision 4: the repack permission covers voiding that order's labels): `VOID_REQUESTED` committed first, then
   the provider call, each bounded by `PROVIDER_TIMEOUT_MS`. Approved → `VOIDED`. `approved: false` →
   `VOID_REJECTED` with the provider's code. Transient → stays `VOID_REQUESTED`. Labels already `VOID_REQUESTED`
   or `VOID_REJECTED` from an earlier attempt are tried again. A provider without `void` → the label is refused
   (`errors.shipping.voidUnsupported`) and an admin writes it off.
3. **If every label of the order is now not live**, one transaction under the order lock: delete the order's
   rates, set each package's `ratesStatus = NONE`, zero `qaVerifiedQuantity` and clear `qaVerifiedAt/ById` on its
   `PackageItem`s, `workflow.repack` (Ready → Packing, reason, stage event, version bump), and with `issueId` call
   `linkIssueToRepack` with the label of the issue's package (else the first voided label). Audit `order.repack`.
4. Otherwise the order stays in Ready and the result lists each label still live with its state and key.

Returns per-order results like `shipOrders`. **Packages are kept** (decision 5): the packer sees the boxes and
weights as they were and changes only what's wrong. Labels are never deleted; their `packageId` still points at
the package, so the history stays on the order.

**Packages with label history** (edit to SPEC-packing): `deletePackage` today refuses a package that has any label
(`errors.packing.packageHasLabels`). After a repack it may only have non-live ones, so `deletePackage` then sets
`Package.discardedAt` instead of deleting (its items return to Unassigned as usual). A package with a live label is
still refused. Discarded packages are skipped by gates, rate fetches, QA, the packing screen and new numbering
(the next package takes `max(number) + 1`), and shown in order history as "Package 2 (discarded)".

**Write-off** (`shipping/labels.ts`): `writeOffLabel({ labelId, reason })` (`label.writeOff`, admins only): a
`VOID_REJECTED` or `VOID_REQUESTED` label the admin has checked at the carrier (it shipped, or the carrier will
bill it regardless). → `WRITTEN_OFF` (a new status that is **not live**), reason and who audited. The row and its
cost stay for reporting. `retryVoid({ labelId })` (`order.repack`) repeats step 2 for one label.

### Manifests (`packages/core/src/shipping/manifests.ts`, FR-SHIP-14)

**Seam addition** (edit to SPEC-carriers, `provider.ts`):

```ts
createManifest?(input: {
  carrierExternalId: string;
  shipDate: string;            // YYYY-MM-DD, the warehouse's date
  providerLabelIds: string[];
}): Promise<{ providerManifestId: string; document: { url: string } | { pdf: Uint8Array } }>;
findManifests?(input: { carrierExternalId: string; shipDate: string }): Promise<
  { providerManifestId: string; providerLabelIds: string[]; document: { url: string } | { pdf: Uint8Array } }[]
>;
```

ShipStation: `POST /v2/manifests` and `GET /v2/manifests` filtered by carrier and date, **verified against the
current v2 reference** when the ticket is built. ShipStation's capability stays `manifests: true`; a carrier it
can't manifest for is refused by the API and surfaces as `notOffered`. Bridge Source: false until booking.

| Function | Permission | Rule |
|---|---|---|
| `manifestCandidates({ shipDate })` | `order.ship` | Per carrier account (`ShippingCarrier`) whose provider can manifest: `ACTIVE` labels with that `shipDate`, on `COMPLETED` orders, with no `manifestId`; plus the day's existing manifests. |
| `createManifest({ carrierId, shipDate, idempotencyKey })` | `order.ship` | Under an advisory lock per (carrier, date). Takes every candidate label at that moment (≥ 1). Calls the provider; on a timeout or lost response, `findManifests` before trying again so one is never created twice. Inserts the `Manifest`, sets the labels' `manifestId`, copies the PDF to storage at `manifests/<id>.pdf`, audits `manifest.create`. A refusal writes nothing and returns its key. Idempotent. |
| `GET /api/manifests/{id}.pdf` | `order.ship` | Streams the stored PDF like a label print. |

Labels on Ready orders aren't manifested: a manifest covers what has been shipped. A label shipped after the day's
manifest goes into a second manifest for the same day.

### Customs (`packages/core/src/shipping/customs.ts`, FR-SHIP-13)

**When:** a package is international when the ship-to country differs from the ship-from country.

**Declaration** (pure `buildCustoms(package, lines, products)`): `{ contents: "merchandise", nonDelivery:
"return_to_sender", items: [{ sku, description, quantity, valueCents, currency, hsCode, countryOfOrigin,
weightOz? }] }`, one item per `PackageItem`: quantity = its units, value = `OrderItem.unitPriceCents` × units,
description = the product's `customsDescription` (else its name), HS code and origin from the variation's product
(a variation uses its parent's fields). Lines whose product isn't physical are skipped.

**Seam addition** (edit to SPEC-carriers): `RateRequest` gains `customs?` with that shape; `PurchaseInput.shipment`
carries it too. The ShipStation adapter maps it to the shipment's `customs` block (`contents`, `non_delivery`,
`customs_items` with `harmonized_tariff_code`, `country_of_origin`, `value`), verified against the v2 reference.
The fakes echo it, and refuse an international purchase without it.

**Missing data:** a package whose declaration lacks an HS code or origin for any line isn't rated: `carriers`'
rate fetch records `rateErrors: [{ messageKey: "errors.shipping.customsIncomplete", params: { products } }]` for
it without calling a provider, and `qa`'s `purchasePreconditions` gains `customsIncomplete { package, products }`
(edits to SPEC-carriers and SPEC-qa). The packing and QA screens show an "International" badge and, when needed,
the products missing data with a link to the editor. Filling the data in and pressing **Refresh rates** clears it.

**Editor:** **Settings → Customs** (`product.manage`): products with physical lines, filterable to "missing customs
data" and "on an international order now", with inline edits of `hsCode` (6–10 digits, dots allowed, stored
without them), `countryOfOrigin` (ISO 3166-1 alpha-2) and `customsDescription` (≤ 100 chars).
`updateProductCustoms({ productId, … })` audits `product.customs`. Store-sync's product sync never overwrites these
(warehouse-owned, as today).

### Reads

- **Ready queue** (existing `queue/[stage]`, stage `ready`): rows gain packages count, carrier/service summary,
  `printState` (`none | partial | printed { times }`), the international badge, and labels with a repack problem
  (`VOID_REQUESTED`, `VOID_REJECTED`). Grouped subqueries in the existing query; the 2,000-order benchmark must
  still pass.
- **Order detail** (`order.read`): per package, every label with status, tracking (linked), carrier/service, cost,
  print count, manifest, void and write-off reasons; the Woo push state, attempts, error and pushed time; for
  `label.print`, **Reprint** per label and per order.
- `pushErrors()` (`settings.manage`), `manifestCandidates`, `customsProducts({ filter, cursor })`.

### API (oRPC, `packages/contracts/src/shipping.ts`)

| Procedure | Route |
|---|---|
| `shipping.createLabelPrint` | `POST /label-prints` |
| `shipping.ship` | `POST /orders/ship` |
| `shipping.repack` | `POST /orders/repack` |
| `shipping.retryVoid` | `POST /labels/{labelId}/retry-void` |
| `shipping.writeOffLabel` | `POST /labels/{labelId}/write-off` |
| `shipping.pushErrors` | `GET /woo-push-errors` |
| `shipping.retryWooPush` | `POST /woo-push-errors/retry` |
| `shipping.manifestCandidates` | `GET /manifests/candidates?shipDate=` |
| `shipping.createManifest` | `POST /manifests` |
| `shipping.customsProducts` | `GET /products/customs` |
| `shipping.updateProductCustoms` | `PATCH /products/{productId}/customs` |

Plus the two PDF route handlers (`/api/label-prints/{id}.pdf`, `/api/manifests/{id}.pdf`), which resolve the actor
and check permission on every request like note attachments. Error keys under `errors.shipping.*`.

### Schema, permission and dependency additions (ask-first: listed here for approval)

One migration:
- `LabelStatus` gains `WRITTEN_OFF` (not live; the workflow's live set stays `PURCHASING`, `ACTIVE`,
  `VOID_REQUESTED`, `VOID_REJECTED`).
- `ShippingLabel.wooTrackingId String?` (AST's `tracking_id`).
- `Settings.wooTrackingEnabled Boolean @default(false)`; `Order.wooTrackingNoteId Int?` (the fallback note).
- `Manifest.storageKey String?`; `formUrl` stays for the provider's link.
- New `LabelPrint`: `id`, `createdById` (FK, SetNull), `labelIds uuid[]` (in print order), `createdAt`. Rows older
  than 30 days are purged by the existing nightly maintenance job.
- `Package.discardedAt DateTime?`; the `(orderId, number)` unique stays (numbers aren't reused).
- `Order.wooPushError` holds a message key (comment only).
- Queue `woo.push` in `jobs.ts`; system actor `shippingActor` (`system: "shipping"`) in `permissions.ts`.
- **Permissions:** `order.repack` (SHIPPER, QA, ADMIN; replaces `order.pack` on the workflow's `repack`, edit to
  SPEC-workflow) and `label.writeOff` (ADMIN only).
- **Dependency:** `pdf-lib` in `@woolrus/core` to merge label PDFs (pure JS, no native build).
- **Dev stack:** the dev WooCommerce container installs the free AST plugin from wordpress.org (pinned version),
  so the on path runs against the real plugin locally and in CI. A compose/Docker change, so ask-first.

### UI

- **Ready queue** (`apps/web/src/app/(app)/queue/[stage]/` for `ready`): row checkboxes and a toolbar with
  **Print labels**, **Ship** and **Repack** (each enabled by permission and selection). Ship's unprinted
  confirmation; Repack's dialog (reason, optional issue for a single order, a clear "labels will be voided"
  warning); per-order result banners. Desktop and tablet; text, not colour alone, for print and repack states.
- **Order detail:** labels table and push panel as in Reads; **Retry void** and **Write off** (admin, confirm and
  reason) on a stuck label.
- **Manifests** (`apps/web/src/app/(app)/manifests/`): a date picker (today by default), a card per carrier
  account with its unmanifested count and **Create manifest**, the day's manifests with **Print**.
- **Sync → Push errors** tab with multi-select **Retry**.
- **Settings → Customs** editor as above; packing and QA screens get the international badge and missing-data
  notice.
- Nav: **Manifests** for `order.ship`. All strings in `en` and `es`.

### Dev data

The fake Woo adapter tracks trackings, notes and status per order and can switch the plugin off. `pnpm db:seed`
leaves `wooTrackingEnabled` off, matching production until IT is done. The fake
shipping providers implement `createManifest`/`findManifests` (a one-page PDF), void with deterministic outcomes
(a ship-to line 2 containing `VOID-REJECT-<n>` rejects package `n`'s void), and validate customs on international
shipments. `pnpm db:seed` adds a Ready order, a Ready order with `VOID-REJECT-2`, a Canadian order whose product
has customs data and one whose product doesn't.

### Files expected to change

`packages/core/src/shipping/{print,ship,woo-push,tracking-provider,repack,labels,manifests,customs,queries}.ts`
(+ tests), `packages/core/src/adapters/woocommerce/{adapter,http,schemas,errors,fake}.ts` + fixtures,
`packages/core/src/adapters/shipping/{provider,fake}.ts`, `adapters/shipping/shipstation/**` (manifests, customs)
+ fixtures, `packages/core/src/carriers/{rates,shipment}.ts`, `packages/core/src/qa/{complete,labels}.ts`,
`packages/core/src/packing/service.ts` (+ the queries that list packages), `packages/core/src/workflow/
{service,gates}.ts`, `packages/core/src/operations/**` (health), `packages/core/src/{permissions,jobs,index}.ts`,
`packages/core/test/factories.ts`, `apps/worker/src/**` (the `woo.push` handler, print purge),
`packages/contracts/src/{shipping,orders,index}.ts`, `apps/web/src/server/router.ts`,
`apps/web/src/app/api/{label-prints,manifests}/**`, `apps/web/src/app/(app)/{queue/**,orders/[id]/**,manifests/**,
sync/**,settings/customs/**,pack/**,qa/**}`, `packages/db/prisma/schema/{shipping,orders}.prisma` + one migration,
`packages/db/prisma/seed-orders.ts`, `packages/i18n/src/messages/{en,es}.json`, `apps/web/e2e/shipping.spec.ts`,
`docker/` (AST in the dev WooCommerce), `apps/web/src/app/(app)/settings/` (the tracking switch), and the edits to `SPEC-carriers`, `SPEC-qa`, `SPEC-workflow`, `SPEC-packing` and
`SPEC-operations` named above.

## Success criteria

1. **Print:** a print of 5 orders returns one PDF with every active label in queue then package order; each
   label's `printCount` goes up by one and the order's status and version don't change. Reprinting one label, and
   printing a Completed order, work. Another user's print id, a print over 24 h old, and a signed-out request get
   404/401; a Picker can't create a print (§7.1 #2).
2. **Ship:** Ready orders become Completed with a stage event naming the shipper and one `woo.push` job each,
   enqueued in the same transaction (a rolled-back ship leaves no job). An order not Ready, or with a package
   lacking an `ACTIVE` label, fails on its own while the rest ship (§7.1 #7). Unprinted labels without
   `confirmUnprinted` write nothing and name the orders.
3. **Push happy path, tracking on:** against the fake store, one tracking item per label with the right provider
   (USPS, UPS, custom for an unknown carrier, never "ShipStation", never comma-joined), customer notes as customer
   notes without author, internal notes private with the prefix, then status completed, in that order; the order
   ends `SUCCEEDED`.
4. **Push, tracking off:** no AST call at all (the fake store has no plugin); one customer note lists every label's
   carrier and number, then the other notes, then completed; `SUCCEEDED`. A retry posts the tracking note once.
5. **Tracking switch:** switching on is refused while the store lacks AST's route, allowed once it has it, audited;
   only `settings.manage` can change it; switching off is always allowed.
6. **Push idempotency:** a job that dies after any call and runs again adds no second tracking item, posts no
   note twice and ends `SUCCEEDED`; a lost response on a tracking or note post is matched from the list, not
   re-posted (§7.1 #8).
7. **Push failure:** the store down → `PENDING` with the error, retried, then `SUCCEEDED` when it's back; AST
   removed while the switch is on, or `unauthorized` → `FAILED` at once, the order still Completed (FR-SHIP-07),
   listed in Push errors; **Retry** by an admin re-runs it; a non-admin can't list or retry.
8. **Repack:** a Ready order's labels end `VOIDED`, rates deleted, verification cleared, packages kept, status
   Packing, stage event and audit with the reason; a linked issue gets `labelId` and `triggeredRepack`. No label
   row is deleted.
9. **Rejected void:** `approved: false` → `VOID_REJECTED`, the order stays Ready with the reason (§7.1 #6);
   **Retry void** approved → the next repack goes through; **Write off** (admin only) → `WRITTEN_OFF`, not live,
   and the repack goes through; a Shipper can't write off.
10. **Discarded packages:** after a repack, deleting a package with only non-live labels discards it; gates, rate
   fetch and QA ignore it; the next package gets a new number; a package with a live label still can't be deleted.
11. **Manifests:** candidates list only today's unmanifested `ACTIVE` labels of Completed orders per carrier
   account; creating one stores the PDF and links exactly those labels; a timeout followed by a retry finds the
   provider's manifest instead of creating a second; a provider without the capability offers nothing.
12. **Customs:** a package to Canada gets a declaration with one item per row, value = unit price × units, HS code
    and origin from the product (variation → parent); rates and purchase carry it; a missing HS code records
    `customsIncomplete` with the product and calls no provider, and QA's Complete QA lists it; a domestic order
    sends no customs.
13. **Permissions:** every procedure and both PDF routes have an allowed and a forbidden test (Shipper ships,
    prints and repacks; QA prints and repacks but can't ship; Packer and Picker can't do any of it; only Admin
    writes off, works push errors and edits customs).
14. **Health:** with the switch on and AST missing, WooCommerce health is degraded with `trackingUnavailable`;
    with it off, health is green either way; Test connection always says whether AST is there.
15. **Performance:** shipping 50 orders returns in under 2 s p95; a 150-label merged PDF streams in under 3 s; the
    Ready queue with the new columns under 300 ms p95 at 2,000 orders.
16. **E2E (desktop + tablet), fake providers and fake store:** a Shipper prints three Ready orders, reprints one
    label, ships them (confirming one unprinted), and the order detail shows "Sent to Woo" with tracking; repacks
    one Ready order and finds it in Packing; a `VOID-REJECT-2` order shows the rejection and an admin writes it
    off; a manifest is created and printed. The go-live journey test (SPEC.md checklist) runs import → … → ship →
    Woo Completed + tracking against the dev stack, once with tracking off (tracking note) and once with it on
    (AST tracking items).
17. **No live writes in tests.** No test pushes to a real store or buys, voids or manifests at a real provider;
    the opt-in live tests are not written without asking first (SPEC.md boundary). Green: `pnpm lint && pnpm
    typecheck && pnpm test && pnpm build` plus Playwright.

## Assumptions

1. IT installs and tests **AST** on the production store on its own schedule, possibly after go-live; until then
   tracking stays off and customers get tracking in a customer note. The WooCommerce REST key must be
   **Read/Write** (store-sync only needed Read): a go-live checklist item, since ship writes to the store either way.
2. The warehouse's ship date is the label's `shipDate` from the provider; manifests are per that date.
3. WooCommerce's Completed email is how the customer hears about shipment; Woolrus sends nothing itself.
4. A Ready order's packages are right unless someone repacks; a repack usually changes one box, which is why
   packages are kept.
5. International parcels are low volume; a customs declaration per package built from line prices is enough
   (no commercial invoice upload, no per-country rules beyond what the provider enforces).
6. Unit price from WooCommerce (after line discounts) is the customs value; currency is the order's.

## Decisions (2026-11-02, asked with the spec)

1. **Tracking via the free Advanced Shipment Tracking (AST) plugin** (changed from the paid Shipment Tracking
   extension, 2026-11-02): one tracking item per label through its REST API, so WooCommerce shows each carrier and
   number and puts them in the Completed email.
2. **Print and ship are two buttons:** printing never changes status and can be repeated; Ship warns, but doesn't
   refuse, when labels were never printed.
3. **Manifests and customs are both in this module and built before go-live.**
4. **Repack gets its own permission, `order.repack`,** held by Shipper, QA and Admin; it covers voiding the
   order's labels, so the person at the Ready station can send an order back.
9. **Tracking is switched on in Settings,** off by default and refused while the store lacks AST, so building and
   shipping never wait for IT to install the plugin.

## Proposed in this draft (confirm or change)

5. **Repack keeps packages** and clears only rates and QA verification (FR-SHIP-08 says packages are cleared;
   they can't be deleted while voided labels point at them, and keeping them saves the packer work). Packing
   discards, rather than deletes, a package with label history.
6. **Rejected voids are written off by an admin** into a new non-live status `WRITTEN_OFF`; nothing else releases
   a label the provider wouldn't void.
7. **Push order is tracking → notes → status,** so the Completed email includes tracking.
8. **The dev WooCommerce runs the real free AST plugin,** so the on path is tested against it locally and in CI.
10. **While tracking is off, the numbers go to the customer as one customer note,** so they aren't left without
    tracking during the gap. (The alternative is to send nothing until the plugin is on.)

## Open questions

None. Both raised in the draft were answered on 2026-11-02:

1. **Existing tracking:** the store's only tracking today comes from the ShipStation for WooCommerce plugin, which
   is a different integration from AST (its own endpoint, no `wc-shipment-tracking` routes), so nothing clashes.
   Woolrus buys labels through ShipStation's API, not through the orders that plugin exports, so the plugin never
   learns about them and can't mark an order shipped twice. At cutover, orders must stop being shipped from
   ShipStation's own screens: if one is, the plugin marks it Completed in the store, and store-sync flags the
   change on the Woolrus order (an existing rule). Go-live checklist item: decide with IT whether the plugin stays
   on after cutover.
2. **REST key:** the current key is Read only. The user is issuing a new Read/Write key for go-live, and it
   replaces the old one in **Settings → Integrations**.
