# Spec: `packing`

**Milestone:** M2 · **Depends on:** `workflow` (claims, the **packed** gate, `completePacking`, live updates),
`picking` (code matching, the finish options it hands over to packing), `notes` (package notes in the drawer) ·
**Used by:** `carriers` (reads package box, dimensions and weight; adds the rate fetch on Packing → QA), `qa`
(verifies `PackageItem`s), `exceptions` (packaging issues on a package), `lumexia` (lot per `PackageItem`) ·
**State:** in progress

Project-wide commands, structure, code style, testing levels and boundaries are in [`../../SPEC.md`](../../SPEC.md);
this spec only adds what is specific to `packing`.

## Objective

Give the packer one tablet screen that turns a picked order into boxes ready for QA: choose a box, put units in it
by tap or scan, weigh it, and send the order on. Every unit's box is stored as a `PackageItem`, so splitting a line
across boxes never rewrites order lines (fixes SRS §7.1 #11), and a package can't leave Packing overweight without
a reason (FR-PACK-09). Admins keep the box sizes the packers choose from.

- **SRS:** FR-PACK-01…06, 08, 09, the box-suggestion half of FR-PACK-10, FR-SET-01, NFR-PERF-02, NFR-UX-01/04/05.
  Fixes SRS §7.1 #11 (split/merge loses notes) and the packing half of #10 (a package without a weight is caught
  by the gate, not skipped).
- **Users:** Packers (`order.pack`) pack; Admins (`box.manage`) manage box sizes. Everyone reads.
- **Why now:** `workflow` routes `completePacking` and has the **packed** gate, but nothing can create a package,
  so no order reaches QA except by `forceStatus`. `carriers` needs packages with boxes and weights to rate.

### User stories

1. As a packer, I open an order from the Packing queue (or from **Done, open in Packing** on the pick screen) and it
   becomes mine. On the left are the unassigned items: image, name, SKU, attributes, substitution, "3 left". On
   the right are the packages.
2. I tap **Add package**. The box picker puts the suggested box first ("Medium box — fits everything, est. 2 lb
   6 oz"), then the other active boxes, then **Custom size**.
3. With Package 1 selected, I scan each jar. Each scan puts one unit in Package 1 and the card counts down. For a
   one-box order I tap **Put everything left in Package 1**.
4. A line of 6 doesn't fit one box. I put 4 in Package 1 and 2 in Package 2. The line still shows once on the
   order, with "4 in #1 · 2 in #2". If I take the 2 back out, they return to Unassigned; nothing on the order
   changes.
5. I put Package 1 on the scale and type 2 lb 7 oz. The box's max weight is shown next to the field. If I type more
   than the max, I'm asked for a reason before it saves.
6. The footer says "2 items unassigned · 1 package without a weight" until both are zero; then **Complete packing**
   appears. I choose **Done** (back to the Packing queue) or **Done, next order** (opens the next unclaimed Packing
   order).
7. I open the drawer to see the order basics, shipping address, who picked what, and every note on the order.
8. As an admin, on **Boxes** I add, edit, archive, restore and delete box sizes, with inner and outer dimensions,
   tare weight and max weight. A box any package has used can only be archived, and its dimensions are locked.

## Scope

**In:**
- Package operations in core: add, change box or custom dimensions, delete, set weight (with override reason),
  pack units, unpack units, pack everything remaining, and scan into a package.
- Box suggestion (pure) from product dimensions and weights, and an estimated weight per package.
- The **packed** gate learns the overweight rule (an edit to `workflow`'s gate, made here).
- Finishing: `completePack` with `after: "queue" | "next"`, calling `workflow`'s `completePacking`.
- Box admin to FR-SET-01: update, restore and delete on top of today's list, create and archive; outer dimensions
  and tare in the form.
- UI: the pack screen, the order drawer, packages on the order detail page, and the full Boxes admin page.
- Schema: one unique index on `package_items` and a re-weigh flag on `packages`. Listed under *Schema additions*.

**Out (owned elsewhere or later):**
- Reading a scale (the rest of FR-PACK-10). Weight is typed (decision 1). A keyboard-wedge scale that types its
  reading works in the field as it is; WebHID or Web Bluetooth drivers wait until the station hardware is chosen.
- Fetching rates when packing completes (FR-PACK-07): `carriers` adds that job to Packing → QA (decision 4).
  Packing only deletes a package's rates when the package changes, so `carriers` never reads stale ones.
- Voiding labels before a repack: `shipping`. Lot capture per `PackageItem`: `lumexia`. Reporting a packaging
  quality issue: `exceptions`.
- The two-step Verify → Pack wizard of FR-PACK-05. Scanning into the box replaces it (decision 2).
- Packing more than one order at once (no pack batches).

## Design

### Package rules (`packages/core/src/packing/service.ts`)

Every package operation runs in one transaction that, like `picking`:
1. `assertCan(actor, "order.pack")`.
2. Reads Settings, then locks the order row (`SELECT … FOR UPDATE`). The order must be `PACKING`
   (`CONFLICT` / `errors.packing.notPacking`) and the actor must hold its live claim
   (`errors.workflow.claimRequired`). A package must belong to the order (`notFound`); a line must belong to the
   order and be physical (`errors.packing.lineNotPackable`).
3. Writes packages and `PackageItem`s.
4. **Invalidates what depended on the old package:** any change to a package's contents, box, dimensions or weight
   deletes its `ShippingRate` rows; a change to its contents also clears `qaVerifiedAt/ById` on all of that
   package's items (relevant after a repack). Labels are never touched.
5. `touchClaim`, `recordAudit(entityType: "Package", action: "package.<op>", before, after)`, and
   `notifyOrderChanged`.

Package writes **don't bump `Order.version`**, for the same reason as pick writes: the claim makes the packer the
only writer, the row lock orders them against transitions, and a burst of optimistic taps must not make the
packer's own `completePack` stale.

**Unassigned** units of a line = active quantity − Σ `PackageItem.quantity` for that line (never below 0 on
screen; an over-packed line, possible only after a void, shows "1 too many in #2" and must be unpacked).

| Operation | Input | Result |
|---|---|---|
| `addPackage` | `orderId`, `box: { boxId } \| { lengthIn, widthIn, heightIn }`, `idempotencyKey` | New package numbered after the last one. The box must be active (`errors.packing.boxArchived`). Custom dimensions use `Inches`. |
| `setPackageBox` | `packageId`, same `box` | Replaces the box or custom dimensions. Marks a weighed package **re-weigh** (gross weight changes with the box). |
| `deletePackage` | `packageId` | Deletes it; its units return to Unassigned. Later packages are renumbered so numbers stay 1…n. Refused with `errors.packing.packageHasLabels` if any label row (even voided) references it; empty it instead. |
| `setWeight` | `packageId`, `weightOz` (`Ounces`, ≤ 2400), `overrideReason?` (1–200) | Sets the weight and clears **re-weigh**. Above the box's `maxWeightOz` without a reason → `CONFLICT` / `errors.packing.overweight` `{ maxOz }`, nothing saved. Within the max, any reason is dropped. Saving the same value again is how the packer confirms a flagged weight. |
| `packUnits` | `packageId`, `orderItemId`, `quantity` (default 1) | Adds units to the line's row in that package (creating it), up to the line's unassigned units (`errors.packing.nothingToPack`). Packed by/at = actor/now. Marks a weighed package **re-weigh**. |
| `unpackUnits` | `packageId`, `orderItemId`, `quantity` (default 1) | Removes units; the row is deleted at 0. Marks a weighed package **re-weigh**. |
| `packRemaining` | `packageId` | Every physical line's unassigned units go into this package. Marks a weighed package **re-weigh**. |
| `scanIntoPackage` | `packageId`, `code`, `scanId` | Resolves the code with `picking`'s `codesForLine` (same normalization, same refusals: `scanNotOnOrder` naming the product, `scanUnknown`) to the first line in pick order with unassigned units and packs 1. All its units already boxed → `errors.packing.scanAlreadyPacked`. Idempotent on `scanId`. |

**Re-weigh, not cleared (decision 5).** A weight read before the last unit went in is the most likely source of a
bad rate (SRS §8 #4), but forcing a re-weigh is wrong when the packer swapped a gallon of A for a gallon of B in the
app to match what's really in the box. So when `packUnits`, `unpackUnits`, `packRemaining`, `scanIntoPackage` or
`setPackageBox` change a package that has a weight, the weight is **kept** and `Package.weightStale` is set. The
package card shows "Contents changed since weighed: re-weigh or confirm" with a **Weight still right** button
(`setWeight` with the same value). It doesn't block the gate.

If `completePack` moves an order with a package still flagged, it writes one internal note on each such package in
the same transaction (`notes`' `createTextNote`, extended to take a `packageId`): "Contents changed after weighing;
weight 2 lb 7 oz not re-checked", so QA sees it on the package. A package weighed or confirmed after its last
change gets no note.

**Weight warning (FR-PACK-10).** When a package's estimate exists (below) and the typed weight differs from it by
more than `WEIGHT_WARNING_RATIO` (25%, a constant), the card shows a non-blocking warning: "2 lb 7 oz is 40% off
the estimate of 1 lb 12 oz". With no estimate, because some product in the box has no weight in the store, no
warning is shown, so a store that doesn't keep product weights never sees it. The warning is computed in the
view; nothing is stored.

`packUnits` / `unpackUnits` add or subtract, so the client sends them only after the previous one for the same
line is confirmed (the card stays optimistic; a queue per line keeps the order). `scanIntoPackage` takes a
`scanId` because a scanner can't wait.

### Gate change (`packages/core/src/workflow/gates.ts`)

**packed** gains one condition per package: weight above the box's `maxWeightOz` with no override reason →
`unmet("packageOverweight", { package, maxOz })`. It can only happen if the box's max is lowered or the box is
changed under an existing weight, but the gate is the rule, so it checks it. `GateSnapshot` packages gain
`maxWeightOz` and `hasOverrideReason`.

### Box suggestion (`packages/core/src/packing/suggest.ts`, pure)

`suggestBox(items, boxes)` where `items` are units with `{ lengthIn, widthIn, heightIn, weightOz }` (from the
variation, else the product) and `boxes` are the active boxes:

- A box **fits** when every unit's sorted dimensions are ≤ the box's sorted inner dimensions, Σ unit volume ≤
  inner volume × `FILL_FACTOR` (0.8, a constant), and Σ unit weight + tare ≤ max weight (when the box has one).
- Result: the smallest fitting box by inner volume (ties: lower max weight, then name), or `{ kind: "split" }`
  when no single box fits (the screen says "Needs more than one box"), or `{ kind: "unknown", missing: [names] }`
  when any unit lacks dimensions or weight. No suggestion is ever applied by itself.
- Asked for the unassigned units when adding a package, and for a package's contents when changing its box.

`estimateWeightOz(units, box)` = Σ unit weight + tare, or null when any weight is missing. Shown next to the weight
field as "est. 2 lb 6 oz"; it never fills the field.

### Reads

- `getPackView({ orderId })` (`order.read`): the order header (number, customer, priority, claim, `version`,
  customer note, shipping method), lines in pick order (`picking`'s `pickOrder`) with image, name, SKU,
  attributes, substitution, active quantity, unassigned quantity and where the rest is ("4 in #1 · 2 in #2"),
  dimensions and weight for suggestion, packages with box (name, inner/outer dimensions, max, tare) or custom
  dimensions, weight, override reason, re-weigh flag, items, note count, estimated weight and the weight
  warning, the active boxes, the **packed**
  gate's unmet list, and the suggestion for the unassigned units.
- **Drawer** (FR-PACK-08) reuses what `workflow` and `notes` already serve: `orders.get` (basics, address, lines
  with picker and time, stage history) and `notes.list` for the order, grouped by target.
- `workflow`'s `getOrder` gains `packages` (number, box name or "Custom", dimensions, weight, items per line), so
  the order detail page and QA see the split.

### Finishing (`completePack`)

`completePack({ orderId, expectedVersion, after: "queue" | "next" })` calls `workflow`'s `completePacking`, then in
the same transaction:
- `queue`: nothing more; the client returns to the Packing queue.
- `next`: claims the first Packing order in queue order with no live claim (`FOR UPDATE SKIP LOCKED`, as
  `picking`'s `next`) and returns its id, or `null` when none is left.

A gate failure moves nothing and returns the unmet list. `picking`'s **Done, open in Packing** now opens
`/pack/[orderId]` instead of the order detail page.

### Box admin (`packages/core/src/boxes/service.ts`)

| Function | Rule |
|---|---|
| `listBoxes` | As today (`box.read`); each box also returns `inUse` (any package references it) for the admin page. |
| `createBox` | As today, plus optional outer dimensions (all three or none, each ≥ the inner one: `errors.box.outerSmaller`). |
| `updateBox` | `box.manage`. Name, max weight and tare are always editable. Inner and outer dimensions are editable only while the box is unused (`errors.box.dimensionsLocked`): packages and labels already bought rely on them. Name unique (`errors.box.nameTaken`). Audited with before/after. |
| `archiveBox` / `restoreBox` | `box.manage`. Archived boxes aren't offered to packers; packages that already use one keep it. |
| `deleteBox` | `box.manage`. Only when unused (`errors.box.inUse`: "archive it instead"). Audited. |

`Box` DTO gains `outerLengthIn/WidthIn/HeightIn` (nullable) and `inUse`.

### API (oRPC, `packages/contracts/src/packing.ts`, `boxes.ts`)

| Procedure | Route |
|---|---|
| `packing.view` | `GET /orders/{orderId}/pack` |
| `packing.addPackage` | `POST /orders/{orderId}/packages` |
| `packing.setBox` | `POST /packages/{packageId}/box` |
| `packing.deletePackage` | `DELETE /packages/{packageId}` |
| `packing.setWeight` | `POST /packages/{packageId}/weight` |
| `packing.packUnits` / `unpackUnits` | `POST /packages/{packageId}/pack`, `…/unpack` |
| `packing.packRemaining` | `POST /packages/{packageId}/pack-remaining` |
| `packing.scan` | `POST /packages/{packageId}/scan` |
| `packing.complete` | `POST /orders/{orderId}/complete-pack` |
| `boxes.update` / `restore` / `delete` | `PATCH /boxes/{id}`, `POST /boxes/{id}/restore`, `DELETE /boxes/{id}` |

Package operations return the updated pack view's packages and lines (one round trip refreshes both sides).

### Schema additions (approved with this spec)

One migration, no new tables:
- `@@unique([packageId, orderItemId])` on `PackageItem`: one row per line per package, so moving units merges
  instead of duplicating (FR-PACK-02).
- `Package.weightStale Boolean @default(false) @map("weight_stale")`: the contents or box changed after the
  package was weighed (decision 5).

The init migration's hand-written constraints (positive quantities and dimensions) already cover the rest and are
untouched. No new permissions (`order.pack`, `box.read`, `box.manage` exist) and no new settings.

### UI (`apps/web/src/app/(app)/`)

- **`pack/[orderId]`:** two columns on a tablet in landscape, stacked in portrait. **Items:** cards at least 160 px
  tall (NFR-UX-01) for lines with unassigned units, each with a big "3 left", tap to put one in the selected
  package, a stepper for several. **Packages:** one card per package (selectable, the selected one outlined and
  labelled, not colour alone), box name and dimensions, its lines with − buttons, the weight field in the
  display unit from `Settings.weightDisplay` with max and estimate beside it, the weight warning and the re-weigh
  banner with **Weight still right**, and a menu with Change box, Put
  everything left here, Delete, Add note. **Add package** opens the box picker (React Aria dialog) with the
  suggestion first. Scans go to the selected package through the same HID buffer as picking
  (`apps/web/src/lib/scanner.ts`), with the same result banner and `aria-live` announcement. The overweight
  reason is a dialog. Footer: the warnings of FR-PACK-06, then **Done** and **Done, next order** once the gate's
  unmet list is empty; Hold; a drawer button.
- **Drawer:** order basics, shipping address, lines with who picked them and when, stage history, notes grouped by
  target (React Aria modal, closes with Escape).
- **Packing queue / order detail:** **Start packing** claims and opens the pack screen; the detail page shows each
  package with its box, weight and contents.
- **`boxes`:** the table gains outer dimensions, tare, max, an In use badge; Edit (dimensions disabled with the
  reason when in use), Archive/Restore, Delete (only when unused). Weights shown and entered in the display unit.
- The pack screen follows the order's SSE events: a takeover or hold elsewhere shows a banner and disables editing.
  All strings in `en` and `es`; toasts for results (NFR-UX-04).

### Dev data

`seedDemoOrders` gains dimensions and weights on the demo products (one without, to show "unknown"), an order
whose items need two boxes, and a line of 6. Seeded boxes gain tare and one gains outer dimensions.

### Files expected to change

`packages/core/src/packing/{service,suggest,queries}.ts` (+ tests), `packages/core/src/boxes/service.ts` (+ test),
`packages/core/src/workflow/{gates,detail}.ts` (overweight, packages on the detail), `packages/core/src/notes/service.ts`
(`createTextNote` takes a `packageId`), `packages/core/src/index.ts`,
`packages/core/test/factories.ts`, `packages/contracts/src/{packing,boxes,orders,index}.ts`,
`apps/web/src/server/router.ts`, `apps/web/src/app/(app)/{pack/**,boxes/**,queue/**,orders/[id]/**,pick/**}`,
`packages/db/prisma/schema/shipping.prisma` + one migration, `packages/db/prisma/seed.ts`,
`packages/i18n/src/messages/{en,es}.json`, `apps/web/e2e/packing.spec.ts`, `apps/web/e2e/boxes.spec.ts`.

## Success criteria

1. **Package rules:** each operation has an allowed test and is refused when the order isn't Packing, the actor
   doesn't hold the live claim, the package or line is from another order, the line is non-physical, or the
   quantity is out of range. A refused operation changes nothing.
2. **Split and merge (FR-PACK-02, §7.1 #11):** 4 + 2 units of one line across two packages leave the `OrderItem`
   row, its notes and its id unchanged; packing a unit into a package that already holds that line increments the
   one row; unpacking to 0 deletes the row; the unique index rejects a duplicate row.
3. **Remove and delete (FR-PACK-03):** deleting Package 2 of 3 returns its units to Unassigned and renumbers
   Package 3 to 2; a package with any label row can't be deleted.
4. **Weight (FR-PACK-04, 09):** a weight within the max saves; above the max it's refused without a reason and
   saved with one; a box without a max takes any weight up to 2400 oz.
5. **Re-weigh (decision 5):** a contents or box change on a weighed package keeps the weight and sets
   `weightStale`; saving the same weight clears it; a flagged package doesn't block the gate; `completePack` writes
   exactly one internal note on each still-flagged package and none on the others. A package never weighed isn't
   flagged.
6. **Weight warning:** shown when the weight is more than 25% off the estimate, in either direction; not shown
   within 25%, and never shown when any product in the package has no weight.
7. **Gate:** the **packed** gate fails with `packageOverweight` for a package over its box's max without a reason
   (after the max is lowered), and the existing conditions still hold. `completePacking` through `/api/v1` on an
   unmet gate changes nothing.
8. **Invalidation:** after a repack, changing a package's contents deletes its rates and clears QA verification on
   its items; changing only its weight deletes its rates and keeps verification. Labels are never deleted.
9. **Scan:** a scan packs one unit of the first matching line with unassigned units into the given package; a
   replayed `scanId` packs nothing; a code from another product is refused naming it; a fully boxed line is
   refused as already packed.
10. **Suggestion:** tested as a pure function: smallest fitting box; a unit too long for a box excludes it however
   much volume is free; weight over max excludes it; no single fit → `split`; a missing dimension → `unknown`
   naming the item; archived boxes are never suggested.
11. **Finish:** `after: "next"` claims the top unclaimed Packing order (two packers finishing at once get different
   orders) or returns `null`; a gate failure moves nothing for either option.
12. **Box admin (FR-SET-01):** create with and without outer dimensions; outer smaller than inner is refused;
    update name/max/tare on a used box works, its dimensions are refused; archive hides it from the pack screen
    but not from packages using it; restore brings it back; delete works only when unused; names stay unique.
13. **Recording:** every package write records one audit event with before/after and emits `order_changed`;
    `Order.version` is unchanged.
14. **Permissions:** every procedure has an allowed and a forbidden test (a Picker can't pack, a Packer can't edit
    boxes, a packer without the claim can't touch the packages).
15. **Performance:** `packUnits` and `scanIntoPackage` server time under 300 ms p95 in an integration benchmark
    (NFR-PERF-02); `getPackView` for 30 lines × 5 packages under 300 ms p95.
16. **E2E (desktop + tablet):** complete picking with **Done, open in Packing** → the pack screen → add the
    suggested box → scan two units (simulated HID) → split a line across two packages → **Complete packing** is
    hidden with the two warnings → weigh one over the max, refused, then saved with a reason → weigh the other →
    swap a unit in the weighed package, which shows **re-weigh** → **Weight still right** clears it →
    **Done, next order** opens the next Packing order and the first is in QA with its packages on the detail page.
    Boxes: create, edit, archive, restore, delete an unused box; a used box offers archive only. A second browser
    taking over the order disables the pack screen without a reload.
17. Green: `pnpm lint && pnpm typecheck && pnpm test && pnpm build` plus Playwright.

## Assumptions

1. The weight typed in is the **gross** weight of the packed box (what the carrier bills); max weight is compared
   with it.
2. A package's custom dimensions are outer dimensions and have no max weight.
3. Orders arrive in Packing only through the **picked** gate (or an admin's `forceStatus`), so packing doesn't
   re-check pick status; it packs the active quantity, substitutions included, and shows the substitution.
4. Product dimensions and weights come from WooCommerce through `store-sync` (already mapped); nobody edits them in
   Woolrus.
5. A box's dimensions being locked once used is acceptable: a resized box is a new box, and the old one is archived.
6. Weight up to 2400 oz (150 lb), the common parcel-carrier limit; heavier shipments aren't handled.

## Decisions (2026-10-26)

1. **Scale:** typed weight only for now; no WebHID or Bluetooth driver until the station hardware is chosen.
2. **Flow:** one screen, no Verify → Pack wizard. Tapping or scanning puts a unit into the selected package.
3. **Overweight:** the packer may save a weight above the box's max with a required reason; the gate refuses an
   overweight package without one.
4. **Rate fetch:** `carriers` adds the rate fetch to Packing → QA. Packing only deletes a package's rates when the
   package changes.
5. **Re-weigh is a flag, not a requirement:** a contents or box change keeps the weight and flags the package; the
   packer re-weighs or confirms it. An unconfirmed flag doesn't block QA, but completing packing leaves an internal
   note on the package for QA.
6. **Weight warning:** shown when the weight is more than 25% off the estimate, and only when every product in the
   package has a weight, so a store that doesn't keep weights never sees it.

## Open questions

None open.
