# Spec: `packing`

**Milestone:** M2 · **Depends on:** `workflow` (claims, the **packed** gate, `completePacking`, live updates),
`picking` (code matching, the finish options it hands over to packing), `notes` (package notes in the drawer) ·
**Used by:** `carriers` (reads package box, dimensions and weight; adds the rate fetch on Packing → QA), `qa`
(verifies `PackageItem`s), `exceptions` (packaging issues on a package), `lumexia` (lot per `PackageItem`) ·
**State:** done; amendment 1 (packing checks, approved 2026-11-12) is **done** (tickets #181–#186); amendment 2
(box picker layout and groups, approved 2026-11-24) is **done** (tickets #226–#228) · **Issue:**
[#24](https://github.com/isaacvarg/woolrus/issues/24); amendment 1:
[#178](https://github.com/isaacvarg/woolrus/issues/178); amendment 2:
[#225](https://github.com/isaacvarg/woolrus/issues/225)

> **Amendment 1 (approved 2026-11-12): packing checks.** The team's concern: a packer physically uses one box but
> selects another in the app, so the label declares the wrong size and UPS bills an adjustment.
>
> - **The checks.** Each package is checked against a set of rules (over the box's max weight, under its new
>   minimum, off the estimate, weighed before the contents changed, items with dimensions that don't fit, box
>   chosen without scanning its barcode, custom dimensions). Each check is set to off, warn or block.
> - **Trips.** A check that fails is a **trip**. Trips show live on the pack screen and are saved when packing
>   completes.
> - **Blocking.** A blocking trip stops Complete packing until a QA or Admin user approves it (`identity` A2).
> - **At QA.** A package with trips is a yellow card on the QA screen. Each trip must be acknowledged, and QA can
>   be required to confirm the physical box, before a label is bought.
> - **Box barcodes.** Each box gets the barcode posted at its shelf area, and scanning it adds a package with that
>   box.
>
> **Dependencies.** This amendment depends on `identity` A2 and `settings`. It edits `workflow`'s gates and `qa`'s
> screen and gate, the way the original spec edited the packed gate. Everything marked *(A1)* below belongs to this
> amendment.

> **Amendment 2 (approved 2026-11-24): box picker layout and groups.** The box picker is one long column sorted by
> name, which gets slow to scan once there are more than a handful of boxes.
>
> - **Columns.** Each user picks 1 or 2 columns for the box picker in their account preferences. The default is 1.
> - **Groups.** Admins put boxes into named groups (for example "Mailers", "Cartons", "Pails"). The picker shows
>   each group under its heading, with a divider between groups, in an order the Admin sets. Boxes with no group
>   come last, under "Other boxes".
> - **Suggestion first.** The suggested box is shown once, at the top, above every group, full width and
>   highlighted.
>
> **Dependencies.** None beyond what packing already has. It adds one field to `identity`'s user preferences, the
> way A1 edited `qa`'s screen (decision 23). Everything marked *(A2)* below belongs to this amendment.

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
9. *(A1)* As a packer, I grab two Medium boxes and one Large and scan the barcode at each box's shelf. Each scan adds
   a package with that box, so I have Packages 1–3 before I've scanned a single item.
10. *(A1)* As a packer, I put a 5-gallon pail into Package 1, a Small box. Its card turns amber: "Pail 5 gal doesn't
    fit Small box (12×10×8)". I change the box to Large and the warning goes away. Had the check been set to block,
    the card would say "Needs approval to complete" instead.
11. *(A1)* As a packer with a blocking trip I can't fix, I tap **Complete packing**. The approval dialog lists the
    trips ("Package 2: 3 lb 2 oz is under Large box's minimum of 4 lb"). Maria from QA enters her PIN with a reason,
    and the order goes to QA.
12. *(A1)* As QA, package 2's card is yellow and lists its trips: who approved it and why, or the packer's
    overweight reason. I check the box on the bench, tap **Medium box (14×12×10): confirmed**, which also
    acknowledges its box trips, and acknowledge the weight trip. Until then **Buy labels** stays disabled, and the
    QA queue row shows "⚠ 2 checks".
13. *(A1)* As an admin, on **Settings → Packing checks** I set each check to off, warn or block, the estimate
    threshold, and whether QA confirms boxes. Next to each check I see its trips and approvals for the last 30 days,
    so I can tell when a check is ready to be set to block.
14. *(A1)* As an admin, on **Boxes** I give a box a minimum weight and the barcode posted at its shelf.
15. *(A2)* As an admin, on **Boxes** I create the groups "Mailers", "Cartons" and "Pails", put each box in one,
    and use **Move up** / **Move down** to put Cartons first, because that's what we use most.
16. *(A2)* As a packer, I open my account menu and set **Box picker columns** to 2. On the next tablet I sign in to,
    it's still 2.
17. *(A2)* As a packer, I tap **Add package**. At the top, full width and outlined, is "Medium carton · Suggested ·
    fits everything, est. 2 lb 6 oz". Below it are the Cartons, then Mailers, then Pails, each under its heading
    in two columns, then "Other boxes", then **Custom size**. Medium carton isn't repeated under Cartons.

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
- *(A1)* The checks below (pure), live on the pack screen, and saved as `PackageCheckTrip` rows when an order leaves
  Packing for QA.
- *(A1)* A mode per check plus two more settings, the estimate threshold and QA box confirmation, on a new
  settings page with 30-day trip counts.
- *(A1)* Blocking at the **packed** gate, which an approval (`identity` A2) lets through.
- *(A1)* QA: yellow package cards, acknowledging trips, box confirmation, two new **verified** gate conditions, and
  a trip badge in the QA queue.
- *(A1)* Boxes gain a minimum weight and a barcode. Scanning a box barcode on the pack screen adds a package.
- *(A2)* Box groups: create, rename, delete and reorder them, and assign a box to at most one group, on the Boxes
  admin page.
- *(A2)* The box picker (Add package and Change box) laid out as: the suggestion, then groups in order, then
  ungrouped boxes, then Custom size, in 1 or 2 columns.
- *(A2)* A per-user preference for the picker's columns (1 or 2, default 1), in the account menu.

**Out (owned elsewhere or later):**
- *(A1)* A "bigger box than suggested" check. It needs dimensions on every item to be trusted, and over-boxing is
  a postage cost rather than a carrier adjustment (decision 15).
- *(A1)* Per-box or per-product check modes. Modes are warehouse-wide (decision 10).
- *(A1)* Reports beyond the 30-day counts (`reporting`). Editing product dimensions in Woolrus: they come from
  WooCommerce, as before (assumption 4).
- Reading a scale (the rest of FR-PACK-10). Weight is typed (decision 1). A keyboard-wedge scale that types its
  reading works in the field as it is; WebHID or Web Bluetooth drivers wait until the station hardware is chosen.
- Fetching rates when packing completes (FR-PACK-07): `carriers` adds that job to Packing → QA (decision 4).
  Packing only deletes a package's rates when the package changes, so `carriers` never reads stale ones.
- Voiding labels before a repack: `shipping`. Lot capture per `PackageItem`: `lumexia`. Reporting a packaging
  quality issue: `exceptions`.
- The two-step Verify → Pack wizard of FR-PACK-05. Scanning into the box replaces it (decision 2).
- Packing more than one order at once (no pack batches).
- *(A2)* Groups anywhere but the pack-screen picker: Rate Lab parcels, the Boxes table layout and order detail
  stay as they are. Groups don't change the suggestion, the checks, box barcode scans, or anything `carriers` or
  `qa` read (decision 27).
- *(A2)* Per-user group order, a box in several groups, manual box order inside a group, and drag-and-drop
  reordering (decisions 25, 26, 28).
- *(A2)* More than 2 columns.

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
| `deletePackage` | `packageId` | Deletes it; its units return to Unassigned. Later packages are renumbered so numbers stay 1…n. Refused with `errors.packing.packageHasLabels` if a **live** label references it (void it first). A package whose labels are all voided or written off (after a repack, SPEC-shipping) is **discarded** instead: `Package.discardedAt` is set, its items are removed (back to Unassigned), and no number is reused (no renumbering once an order has a discarded package; the next package takes `max(number) + 1`). Gates, rate fetches, QA and the packing screen skip discarded packages; order history shows "Package 2 (discarded)". |
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
(`setWeight` with the same value). It doesn't block the gate. *(A1)* It now does when the **re-weigh** check is
set to block (decision 13).

If `completePack` moves an order with a package still flagged, it writes one internal note on each such package in
the same transaction (`notes`' `createTextNote`, extended to take a `packageId`): "Contents changed after weighing;
weight 2 lb 7 oz not re-checked", so QA sees it on the package. A package weighed or confirmed after its last
change gets no note. *(A1)* The note is written only while the **re-weigh** check is off. Otherwise the trip
carries the same message to QA, and a note as well would say it twice.

**Weight warning (FR-PACK-10).** When a package's estimate exists (below) and the typed weight differs from it by
more than `WEIGHT_WARNING_RATIO` (25%, a constant), the card shows a non-blocking warning: "2 lb 7 oz is 40% off
the estimate of 1 lb 12 oz". With no estimate, because some product in the box has no weight in the store, no
warning is shown, so a store that doesn't keep product weights never sees it. The warning is computed in the
view; nothing is stored. *(A1)* This warning becomes the **off the estimate** check. The threshold moves from the
constant to `Settings.packCheckWeightOffPercent`, and the mode decides whether the warning shows and whether it
blocks.

**Overweight *(A1)*.** What happens above the box's max depends on the **over max** check's mode, which can be
warn or block but not off (decision 11):
- **Warn:** as today. `setWeight` refuses without a reason, and the reason is saved and shown on the trip.
- **Block:** `setWeight` saves the weight without asking for a reason, because the packer's own reason isn't enough
  here. The trip blocks Complete packing until someone approves it, and the approval's reason is the one on record.
  `weightOverrideReason` stays null.

`packUnits` / `unpackUnits` add or subtract, so the client sends them only after the previous one for the same
line is confirmed (the card stays optimistic; a queue per line keeps the order). `scanIntoPackage` takes a
`scanId` because a scanner can't wait.

### Gate change (`packages/core/src/workflow/gates.ts`)

**packed** gains one condition per package: weight above the box's `maxWeightOz` with no override reason →
`unmet("packageOverweight", { package, maxOz })`. It can only happen if the box's max is lowered or the box is
changed under an existing weight, but the gate is the rule, so it checks it. `GateSnapshot` packages gain
`maxWeightOz` and `hasOverrideReason`.

*(A1)* The gate changes as follows:

- **`packageOverweight`** applies only while **over max** is on warn.
- **Every blocking trip** adds `unmet("packCheckBlocked", { package, check })` to **packed**, unless the
  transition carries an approval. `completePacking` (packing's `completePack` and `workflow`'s
  `/api/v1/…/complete-packing` alike) takes an optional `approval` (`identity` A2's `approvalInput`).
  - When the approval is present, `verifyApprover(…, { permission: "packCheck.approve" })` runs before the
    transaction.
  - The transition then evaluates the gate with `approved: true`, which drops `packCheckBlocked`. Every other
    condition still applies.
  - It then calls `recordApproval` with kind `PACKING_CHECKS`, entity `Order`, and `details` = the blocking trips.
  - An approval sent when nothing blocks is ignored. No row is written, so a careless client can't create
    approvals.
- **`GateSnapshot` packages gain `trips`**, the live evaluation below with the current settings, so the gate,
  the pack view and the saved rows share one function.
- **`verified` gains two conditions per package**, read from the saved rows:
  - `unmet("packCheckUnacknowledged", { package, count })`;
  - `unmet("packageBoxUnconfirmed", { package })` when box confirmation is required for it.

  `qa`'s `purchaseConditions` already derives from `verified`, so label purchase is refused on the server too.

### Packing checks *(A1)* (`packages/core/src/packing/checks.ts`, pure)

`evaluateChecks(pkg, units, settings)` → `Trip[]`, where `Trip = { check, mode: "WARN" | "BLOCK", details }`.
Checks set to off are never evaluated. A discarded package is never checked.

| Check (`PackCheck`) | Trips when | `details` | Modes |
|---|---|---|---|
| `OVER_MAX` | the package has a box with a max, and weight > max | `{ weightOz, maxOz, reason? }` | warn, block |
| `UNDER_MIN` | the package has a box with a min, and weight < min | `{ weightOz, minOz }` | off, warn, block |
| `WEIGHT_OFF` | an estimate exists and the weight is more than `packCheckWeightOffPercent` off it | `{ weightOz, estimateOz, percent }` | off, warn, block |
| `WEIGHT_STALE` | `weightStale` | `{ weightOz }` | off, warn, block |
| `NO_FIT` | at least one unit has all three dimensions, and those units fail the fit rule against the box's inner dimensions (or the custom dimensions) | `{ boxName?, items: [names] }` | off, warn, block |
| `BOX_NOT_SCANNED` | the package has a box and `boxScanned` is false | `{ boxName }` | off, warn, block |
| `CUSTOM_DIMENSIONS` | the package has custom dimensions | `{ lengthIn, widthIn, heightIn }` | off, warn, block |

Notes on the checks:
- **Fit rule:** the fit test is pulled out of `suggestBox` into `fitsIn(units, innerDims)` (each unit's sorted
  dimensions ≤ the sorted inner ones, Σ volume ≤ inner volume × `FILL_FACTOR`). The suggestion and `NO_FIT` then
  can't disagree.
- **Partial dimensions:** units without dimensions take no space, so one pail with dimensions in a box of unmeasured
  jars is still checked (decision 12). Weight isn't part of `NO_FIT`; `OVER_MAX` covers it.
- **Unweighed packages:** a package with no weight trips nothing that needs a weight. The gate's `packageNoWeight`
  already stops it.
- **Custom-size packages:** they skip `OVER_MAX` and `UNDER_MIN`, since there's no box to read limits from
  (assumption 2). They are fit-checked against the typed dimensions, and trip `CUSTOM_DIMENSIONS` (decision 14).

**Live:** `getPackView` returns each package's `trips`. `weightWarning` is removed, since `WEIGHT_OFF` replaces it.
The pack view also returns `blocking: boolean` for the footer. Trips are recalculated on every package write's
response, and nothing is stored while the order is in Packing.

**Saved (`PackageCheckTrip`):**
- **When they're saved:** in the same transaction that moves an order from `PACKING` to `QA`, by `completePacking`
  or by an Admin's `forceStatus` (decision 16). Each WARN and BLOCK trip becomes one row: package, check, mode,
  `details`, and the transition's `approvalId` on blocking rows.
- **Force-status:** it skips the gate and brings no approval, so its blocking rows have no `approvalId`. QA sees
  "moved by force-status" with the force-status reason instead (read from the stage event).
- **Clearing them:** a transition into `PACKING` (repack, or `forceStatus` back) deletes the order's trip rows and
  clears every package's box confirmation in the same transaction, the way `repackOne` already clears QA
  verification (decision 17). `Approval` rows stay as history.
- **Settings changes:** trips in QA are never re-evaluated. Changing a mode affects orders still in Packing only.
  Box confirmation is the exception: it is read live (below).

**Box barcodes:**
- **In box admin:** a box's optional `barcode` is unique among boxes. It's refused when it normalizes (with
  `picking`'s code normalization) to a product's or variation's barcode or SKU, or looks like a lot code
  (`isLotCode`) (decision 18). It's editable while the box is in use, unlike its dimensions.
- **On the pack screen:** the scanner handler checks codes in this order: lot code, then box barcode (the view
  carries the active boxes' barcodes), then product. A box code calls `addPackage` with `box: { barcode }`. Core
  resolves the barcode itself and sets `boxScanned: true`, so a client can't mark a tapped box as scanned.
- **What a scan does:** every box scan adds a new package, and no package needs to be selected (decision 9). An
  archived box's barcode is refused with `errors.packing.boxArchived`. An unknown code goes on to the product match
  as today. Changing an existing package's box stays a tap (`setPackageBox`, `boxScanned: false`).

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

*(A1)* `completePack` takes the optional `approval` and passes it to `completePacking` (see *Gate change*). A
refused approval (bad PIN, locked, not permitted, self) moves nothing. The wrong-PIN count still goes up, because
`verifyApprover` commits on its own.

### QA side *(A1)* (`packages/core/src/qa/`, `apps/web/src/app/(app)/qa/[orderId]/`)

- **The QA view:** `getQaView` packages gain:
  - `trips`: the saved rows, with an approval summary (approver name, reason, time) or the packer's overweight
    reason;
  - `boxConfirmRequired` and `boxConfirmed` (by whom and when).
- **When box confirmation is required:** `Settings.qaBoxConfirm` is `OFF` (never), `WHEN_TRIPPED` (packages with
  any trip, the default) or `ALWAYS` (every package). It's read live, so changing it affects orders already in QA.
- **`acknowledgeCheck({ tripId })`** (`order.qa`, `lockForQa`: status QA and the actor's live claim) sets
  `acknowledgedAt/ById` and audits `packCheckTrip.acknowledge`. It's idempotent, and there's no un-acknowledge.
- **`confirmBox({ packageId })`** (same guard) sets `Package.boxConfirmedAt/ById`, acknowledges that package's
  box-related trips (`NO_FIT`, `UNDER_MIN`, `OVER_MAX`, `BOX_NOT_SCANNED`, `CUSTOM_DIMENSIONS`) in the same
  transaction, and audits `package.confirmBox`. It's allowed even when not required. The weight trips (`WEIGHT_OFF`,
  `WEIGHT_STALE`) still need their own acknowledgement (decision 19).
- **The QA screen:** a package card with any trip gets the warning style (daisyUI `border-warning` +
  `bg-warning/10`) and a ⚠ icon with "N checks", so it's not shown by colour alone. Each trip is listed with its
  message, details and approval, with an **Acknowledge** button or "Acknowledged by …". When required, a
  **Confirm box** row shows the box's name and inner dimensions large enough to compare at a glance. **Buy labels**
  shows the new unmet conditions with the others.
- **The QA queue:** `listQueue` rows gain `packCheckTrips` (unacknowledged trips on the order).
  `queue-table.tsx` shows "⚠ N checks" next to the issue and void badges, on the QA queue only.

### Settings *(A1)*

New columns on `Settings`, edited on **Settings → Packing checks** (`settings.manage`, a sub-page like
`settings/shipping/cost-check`) and returned in `PublicSettings` so the pack and QA screens can read them:

| Setting | Values | Default |
|---|---|---|
| `packCheckOverMax` | `WARN`, `BLOCK` (`OFF` refused: `errors.settings.checkCannotBeOff`) | `WARN` |
| `packCheckUnderMin`, `packCheckWeightOff`, `packCheckWeightStale`, `packCheckNoFit`, `packCheckCustomDimensions` | `OFF`, `WARN`, `BLOCK` | `WARN` |
| `packCheckBoxNotScanned` | `OFF`, `WARN`, `BLOCK` | `OFF` (until box barcodes are entered) |
| `packCheckWeightOffPercent` | whole percent, 5–100 | 25 |
| `qaBoxConfirm` | `OFF`, `WHEN_TRIPPED`, `ALWAYS` | `WHEN_TRIPPED` |

**30-day counts:** `packChecks.stats` (`settings.manage`) returns, per check, the trips saved in the last 30 days
and how many of them were approved, from `PackageCheckTrip.createdAt` (decision 20). The page shows these next to
each mode.

**Permission:** `packCheck.approve` is new, given to QA (and to Admin, who has every permission).

### Box admin (`packages/core/src/boxes/service.ts`)

| Function | Rule |
|---|---|
| `listBoxes` | As today (`box.read`); each box also returns `inUse` (any package references it) for the admin page. |
| `createBox` | As today, plus optional outer dimensions (all three or none, each ≥ the inner one: `errors.box.outerSmaller`). |
| `updateBox` | `box.manage`. Name, max weight and tare are always editable. Inner and outer dimensions are editable only while the box is unused (`errors.box.dimensionsLocked`): packages and labels already bought rely on them. Name unique (`errors.box.nameTaken`). Audited with before/after. |
| `archiveBox` / `restoreBox` | `box.manage`. Archived boxes aren't offered to packers; packages that already use one keep it. |
| `deleteBox` | `box.manage`. Only when unused (`errors.box.inUse`: "archive it instead"). Audited. |

`Box` DTO gains `outerLengthIn/WidthIn/HeightIn` (nullable) and `inUse`.

*(A1)* `createBox` / `updateBox` take optional `minWeightOz` and `barcode`:
- `minWeightOz` must be below `maxWeightOz` when both are set (`errors.box.minNotBelowMax`).
- The barcode rules are under *Box barcodes* (`errors.box.barcodeTaken`, `errors.box.barcodeIsProduct`).

Both are always editable, and the DTO returns both.

### Box groups *(A2)* (`packages/core/src/boxes/groups.ts`)

A `BoxGroup` has a unique name (trimmed, 1–60 characters, compared case-insensitively) and a `position`. A box
has at most one group (`Box.groupId`, nullable). Groups are for display in the picker only (decision 27).

| Function | Rule |
|---|---|
| `listBoxGroups` | `box.read`. Every group, ordered by `position`, then name. Each returns its active box count for the admin page. |
| `createBoxGroup` | `box.manage`. Appended at the end (`position` = current max + 1). Name unique (`errors.boxGroup.nameTaken`). Audited. |
| `renameBoxGroup` | `box.manage`. Same name rule. Audited with before/after. |
| `moveBoxGroup` | `box.manage`. `direction: "up" \| "down"` swaps `position` with the neighbour in one transaction. Moving the first group up or the last down is a no-op that returns the list unchanged. Audited. |
| `deleteBoxGroup` | `box.manage`. Deletes the group, and its boxes become ungrouped (`ON DELETE SET NULL`) in the same transaction. Archived boxes in it are ungrouped too. Positions keep their gaps; order is all that matters. Audited, with the names of the boxes that were ungrouped. |

`createBox` and `updateBox` take an optional `groupId` (nullable; an unknown id is `errors.boxGroup.notFound`).
It's always editable, including on a box in use and on an archived box. The `Box` DTO returns `groupId`.

### Box picker layout *(A2)* (`packages/core/src/packing/picker.ts`, pure)

`arrangeBoxPicker(boxes, groups, suggestion)` returns
`{ suggested: Box | null, sections: { group: BoxGroup | null, boxes: Box[] }[] }`:

- `suggested` is the suggested box when `suggestion.kind === "box"`, otherwise null. It is left out of every
  section, so it appears once (decision 30).
- One section per group in `position` order, with its active boxes A–Z by name. A group with no box left after
  that (empty, all archived, or only the suggested box) is left out (decision 33).
- Then one section with `group: null` for the ungrouped boxes, A–Z, if there are any.
- With no groups at all, there is only the `group: null` section, and the UI shows no heading. That's today's
  picker (decision 29).

The pack view (`getPackView`) returns `boxGroups` next to `boxes`, so the dialog needs no extra request.

### Picker columns *(A2)* (`packages/core/src/identity/preferences.ts`)

`Preferences` gains `boxPickerColumns: 1 | 2` (default 1), saved on the user like language and theme (FR-SET-03),
so it follows them to every station. `me.updatePreferences` accepts it, and `me.get` returns it.

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

*(A1)*

| Procedure | Route / change |
|---|---|
| `packing.addPackage` | `box` also accepts `{ barcode }` |
| `packing.complete`, `orders.completePacking` | input gains optional `approval` |
| `qa.acknowledgeCheck` | `POST /pack-check-trips/{tripId}/acknowledge` |
| `qa.confirmBox` | `POST /packages/{packageId}/confirm-box` |
| `packChecks.stats` | `GET /settings/packing-checks/stats` |
| `settings.update` / `settings.get` | the new columns |

*(A2)* (`packages/contracts/src/boxes.ts`, `me.ts`, `packing.ts`)

| Procedure | Route / change |
|---|---|
| `boxGroups.list` | `GET /box-groups` |
| `boxGroups.create` | `POST /box-groups` |
| `boxGroups.rename` | `PATCH /box-groups/{id}` |
| `boxGroups.move` | `POST /box-groups/{id}/move` (`{ direction }`), returns the ordered list |
| `boxGroups.delete` | `DELETE /box-groups/{id}` |
| `boxes.create` / `boxes.update` | input gains optional `groupId`; `Box` gains `groupId` |
| `packing.view` | output gains `boxGroups` |
| `me.get` / `me.updatePreferences` | `boxPickerColumns` |

### Schema additions (approved with this spec)

One migration, no new tables:
- `@@unique([packageId, orderItemId])` on `PackageItem`: one row per line per package, so moving units merges
  instead of duplicating (FR-PACK-02).
- `Package.weightStale Boolean @default(false) @map("weight_stale")`: the contents or box changed after the
  package was weighed (decision 5).

The init migration's hand-written constraints (positive quantities and dimensions) already cover the rest and are
untouched. No new permissions (`order.pack`, `box.read`, `box.manage` exist) and no new settings.

*(A1)* One migration (ask-first, listed for approval), after `identity` A2's:

```prisma
enum PackCheck { OVER_MAX UNDER_MIN WEIGHT_OFF WEIGHT_STALE NO_FIT BOX_NOT_SCANNED CUSTOM_DIMENSIONS }
enum PackCheckMode { OFF WARN BLOCK }
enum QaBoxConfirm { OFF WHEN_TRIPPED ALWAYS }

// Box
minWeightOz Decimal? @map("min_weight_oz") @db.Decimal(10, 2)
barcode     String?  @unique

// Package
boxScanned       Boolean   @default(false) @map("box_scanned")
boxConfirmedAt   DateTime? @map("box_confirmed_at") @db.Timestamptz(3)
boxConfirmedById String?   @map("box_confirmed_by_id") @db.Uuid

/// A check that tripped on a package when its order left Packing (SPEC-packing A1).
model PackageCheckTrip {
  id                String        @id @default(uuid(7)) @db.Uuid
  packageId         String        @map("package_id") @db.Uuid
  check             PackCheck
  mode              PackCheckMode // WARN or BLOCK (hand-written CHECK)
  details           Json          @default("{}")
  approvalId        String?       @map("approval_id") @db.Uuid
  acknowledgedAt    DateTime?     @map("acknowledged_at") @db.Timestamptz(3)
  acknowledgedById  String?       @map("acknowledged_by_id") @db.Uuid
  createdAt         DateTime      @default(now()) @map("created_at") @db.Timestamptz(3)
  // relations: Package (cascade), Approval, User
  @@unique([packageId, check])
  @@index([createdAt])
  @@map("package_check_trips")
}

// Settings: the columns in *Settings* above (enums, with their defaults)
```

Hand-written constraints:
- `CHECK (mode <> 'OFF')` on trips;
- `CHECK (min_weight_oz IS NULL OR max_weight_oz IS NULL OR min_weight_oz < max_weight_oz)` on boxes;
- `CHECK (pack_check_over_max <> 'OFF')` and `CHECK (pack_check_weight_off_percent BETWEEN 5 AND 100)` on settings.

New permission `packCheck.approve` (QA).

*(A2)* One migration (ask-first, listed for approval):

```prisma
/// A named set of boxes, shown together in the pack screen's box picker (SPEC-packing A2).
model BoxGroup {
  id        String   @id @default(uuid(7)) @db.Uuid
  name      String
  position  Int
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt DateTime @updatedAt @map("updated_at") @db.Timestamptz(3)

  boxes Box[]

  @@map("box_groups")
}

// Box
groupId String?   @map("group_id") @db.Uuid
group   BoxGroup? @relation(fields: [groupId], references: [id], onDelete: SetNull)
@@index([groupId])

// User
boxPickerColumns Int @default(1) @map("box_picker_columns")
```

Hand-written constraints:
- `CREATE UNIQUE INDEX box_groups_name_lower ON box_groups (lower(name))`;
- `CHECK (box_picker_columns IN (1, 2))` on users.

No unique index on `position`: a swap would trip it mid-transaction, and ties fall back to the name. No new
permissions (`box.read` and `box.manage` cover groups) and no new settings.

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
- *(A1)* **Pack screen:**
  - **Package cards:** each card lists its live trips. A warn trip is amber with a ⚠ icon. A block trip is red
    with "Needs approval to complete". The weight warning is now the `WEIGHT_OFF` trip, and the overweight reason
    dialog appears only in warn mode.
  - **Box scans:** a box barcode scan announces "Package 3 added: Medium box" through the scan banner and
    `aria-live`.
  - **Footer:** with blocking trips and an otherwise empty unmet list, **Done** and **Done, next order** read
    "… (needs approval)" and open `identity`'s `ApprovalDialog`. It lists the blocking trips and loads tiles for
    `packCheck.approve`. On approve it sends `completePack` with the approval.
- *(A1)* **QA screen and queue:** as in *QA side*.
- *(A1)* **Settings → Packing checks:**
  - a mode select per check, with its 30-day trips and approvals beside it;
  - the threshold field;
  - QA box confirmation;
  - a one-line explanation of each check.
- *(A1)* **Boxes:** the form gains min weight (display unit) and barcode, and the table shows both.
- *(A2)* **Box picker** (`pack/[orderId]/box-dialog.tsx`), from top to bottom:
  - the split or unknown message, as today;
  - the suggested box, full width in either layout, with a 2 px primary border, the **Suggested** badge and the
    fit text (so it isn't marked by colour alone);
  - each section from `arrangeBoxPicker`: an `h3` with the group name and a divider above it, then its boxes in
    a `grid` of `boxPickerColumns` columns. The `group: null` section is headed "Other boxes", and only when at
    least one group section is shown;
  - **Custom size**, unchanged.

  Two columns drop to one below 480 px wide (`grid-cols-1 min-[480px]:grid-cols-2`), so a phone in portrait
  stays readable. Each box button stays at least 64 px tall, with its name and dimensions. Each section is a
  `role="group"` labelled by its heading, so a screen reader announces the group.
- *(A2)* **Account menu** (`nav-footer.tsx`): a **Box picker columns** choice (1 / 2) next to language and theme.
  It saves the same way they do, and shows on every user's menu (it only affects the pack screen).
- *(A2)* **Boxes:**
  - a **Groups** panel above the table, listing groups in order with the box count, **Move up** / **Move down**
    (disabled at the ends), Rename, Delete, and **Add group**. Delete confirms in a dialog: "3 boxes will move to
    Other boxes";
  - the box form gains a **Group** select ("No group" first, then groups in order);
  - the table gains a Group column.

### Dev data

`seedDemoOrders` gains dimensions and weights on the demo products (one without, to show "unknown"), an order
whose items need two boxes, and a line of 6. Seeded boxes gain tare and one gains outer dimensions.

### Files expected to change

*(A1)* `packages/core/src/packing/{checks,service,suggest,queries,complete}.ts` (+ tests),
`packages/core/src/boxes/service.ts`, `packages/core/src/workflow/{gates,service}.ts`,
`packages/core/src/qa/{verify,queries,complete}.ts`, `packages/core/src/shipping/repack.ts`,
`packages/core/src/workflow/queries.ts` (queue count), `packages/core/src/settings/service.ts`,
`packages/core/src/permissions.ts`, `packages/contracts/src/{packing,boxes,orders,qa,settings,index}.ts`,
`apps/web/src/server/router.ts`, `apps/web/src/app/(app)/{pack/**,qa/**,queue/**,boxes/**,settings/**}`,
`packages/db/prisma/schema/{shipping,system}.prisma` + one migration, `packages/db/prisma/seed.ts` (box min weights
and barcodes; dimensions on a demo pail), `packages/i18n/src/messages/{en,es}.json`,
`apps/web/e2e/{packing,qa}.spec.ts` (or a new `packing-checks.spec.ts`), `docs/decisions.md`, `docs/specs/SPEC-qa.md`
(a pointer to this amendment).

*(A2)* `packages/core/src/boxes/{groups,service}.ts` (+ tests), `packages/core/src/packing/{picker,queries}.ts`
(+ tests), `packages/core/src/identity/preferences.ts` (+ test), `packages/contracts/src/{boxes,me,packing,index}.ts`,
`apps/web/src/server/router.ts`, `apps/web/src/app/(app)/{pack/[orderId]/box-dialog.tsx,pack/[orderId]/pack-screen.tsx,nav-footer.tsx,boxes/**}`,
`packages/db/prisma/schema/{shipping,auth}.prisma` + one migration, `packages/db/prisma/seed.ts` (two demo groups,
one box left ungrouped), `packages/i18n/src/messages/{en,es}.json`, `apps/web/e2e/boxes.spec.ts` and
`apps/web/e2e/packing.spec.ts` (or a new `box-picker.spec.ts`), `docs/decisions.md`.

Original scope: `packages/core/src/packing/{service,suggest,queries}.ts` (+ tests), `packages/core/src/boxes/service.ts` (+ test),
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

*(A1)*

18. **Checks (pure):** each check trips and doesn't trip at its boundary:
    - `OVER_MAX`: max + 0.01 trips, max doesn't.
    - `UNDER_MIN`: min − 0.01 trips, min doesn't.
    - `WEIGHT_OFF`: trips at threshold + 1%, not at the threshold; it reads the setting, not the constant.
    - `NO_FIT`:
      - a pail too tall for Small trips, and the same pail in Large doesn't;
      - a box holding one pail with dimensions and three jars without them is checked, while a box with no
        measured units isn't;
      - custom dimensions are fit-checked;
      - it agrees with `suggestBox` on every suggestion test case.

    An unweighed package trips no weight check, and a check set to off never trips.
19. **Block and approve:** with `NO_FIT` on block, `completePack` and `/api/v1/…/complete-packing` fail with
    `packCheckBlocked` and move nothing.
    - With a QA user's approval, both move the order to QA. They write one `Approval` (kind `PACKING_CHECKS`,
      `details` = the blocking trips) and trip rows whose blocking ones point at it.
    - The packer's own PIN, a Packer's PIN, or a wrong PIN is refused, and nothing moves.
    - An approval sent with nothing blocking writes no `Approval` row.
    - With every check on warn, nothing needs approval.
20. **Overweight modes:** in warn, `setWeight` above the max needs a reason, as before (criterion 4 holds). In
    block, it saves without one, the gate reports `packCheckBlocked` instead of `packageOverweight`, and an approval
    lets it through. `packCheckOverMax: OFF` is refused by the contract and by the database CHECK.
21. **Saved trips:** completing writes exactly one row per WARN or BLOCK trip and none for off checks. Force-status
    from Packing to QA writes them too, without an approval. A repack, or force-status back to Packing, deletes them
    and clears box confirmations, while `Approval` rows remain. Changing a mode while an order is in QA leaves its
    trips unchanged.
22. **Re-weigh note:** with `WEIGHT_STALE` off, completing still writes the internal note (criterion 5). With it on,
    no note is written and the trip is saved instead.
23. **QA:**
    - `acknowledgeCheck` and `confirmBox` need `order.qa` and the live claim.
    - `confirmBox` acknowledges exactly the box-related trips on its package.
    - **verified:**
      - With an unacknowledged trip, `packCheckUnacknowledged` refuses label purchase on the server.
      - With `qaBoxConfirm` set to `WHEN_TRIPPED`, a tripped package needs confirmation and a clean one doesn't.
      - With `ALWAYS`, every package needs it.
      - With `OFF`, none do.
    - The QA queue row's count matches the unacknowledged trips.
24. **Box admin:** a min weight not below the max, a barcode already on another box, a barcode equal to a
    product's barcode or SKU after normalization, and a lot-code-shaped barcode are all refused. Min weight and
    barcode are editable on a box in use.
25. **Box scan:** scanning a box barcode adds a package with that box and `boxScanned: true`, with or without a
    selected package; three scans give three packages; an archived box's barcode is refused; tapping a box or
    changing it gives `boxScanned: false`; a replayed `idempotencyKey` (one per scan) adds nothing.
26. **Settings and stats:** the new fields save with audit before/after. The percent must be 5–100. `packChecks.stats`
    counts only the last 30 days, per check, with the approved count.
27. **Permissions:** `packCheck.approve` holders are QA and Admin only. `acknowledgeCheck`, `confirmBox` and
    `packChecks.stats` each have an allowed and a forbidden test.
28. **E2E (tablet):**
    - **Pack:** scan two box barcodes, which adds two packages, then pack the demo pail into the Small one. The
      card shows the `NO_FIT` trip, which is set to block. **Done** opens the approval dialog; a wrong PIN shows the
      error, and a QA user's PIN with a reason completes it.
    - **QA:** the package card is yellow, and **Buy labels** lists the unacknowledged trip and the unconfirmed box.
      **Confirm box** clears both. The queue row showed "⚠ 1 check" before that.

*(A2)*

29. **Groups:**
    - create appends at the end;
    - a name that matches another after trimming and ignoring case is refused, by the service and by the unique
      index;
    - rename is audited with before/after;
    - move up and down swap with the neighbour, and the ends are no-ops;
    - delete ungroups its boxes, archived ones included, and deletes no box;
    - every write records one audit event.
30. **Box group field:** create and update take `groupId`; an unknown id is refused; it's editable on a box in use
    and on an archived box; `null` ungroups.
31. **Layout (pure, `arrangeBoxPicker`):**
    - the suggested box is `suggested` and in no section;
    - groups follow `position`, with boxes A–Z inside;
    - ungrouped boxes come last in the `group: null` section;
    - a group that is empty, all archived, or holds only the suggested box is left out;
    - with no groups there is exactly one section, `group: null`;
    - a `split` or `unknown` suggestion gives `suggested: null`;
    - archived boxes never appear.
32. **Preference:** `boxPickerColumns` defaults to 1, saves 2, and comes back from `me.get`. 3 is refused by the
    contract and by the database CHECK. Another user's value is unchanged.
33. **Permissions:** `boxGroups.list` is allowed for `box.read`. `create`, `rename`, `move` and `delete` are allowed
    for `box.manage` and forbidden for a Packer.
34. **Component (Vitest):** the picker renders the suggestion full width with the badge and border, then group
    headings in order with a divider, then "Other boxes", then Custom size. It renders no headings when there are no
    groups, and uses 2 columns only when the preference is 2.
35. **E2E (tablet):**
    - **Admin:** on Boxes, create two groups, assign boxes, leave one ungrouped, move the second group up, delete
      a group and see its boxes in "Other boxes".
    - **Packer:** set **Box picker columns** to 2. Open **Add package**: the suggested box is first, full width,
      and not repeated in its group. The groups follow the admin's order, then "Other boxes". **Change box**
      shows the same layout. At 375 px wide the grid is one column.

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
7. *(A1)* Every product has a weight in WooCommerce. Dimensions are entered in WooCommerce for the bulky items that
   matter (gallons, pails) and arrive through `store-sync` as today.
8. *(A1)* The six boxes are visually distinct and kept in designated areas, each with one barcode posted there.
   Individual boxes aren't labelled, so a scan proves the packer was at that shelf, not which box they're holding.
9. *(A1)* There is always a QA or Admin user on shift to approve, so blocking never strands an order.
10. *(A2)* The warehouse has at most a few dozen boxes and a handful of groups, so the picker needs no search or
    collapsing, and up/down buttons are quick enough to reorder.
11. *(A2)* Group names are entered by the Admin in the language the floor reads, and aren't translated. Only "Other
    boxes" and the UI strings are in `en` and `es`.

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

### Amendment 1 (approved 2026-11-12, from the packing-checks grilling)

7. **An amendment to packing, not a new module.** The checks are about packages and boxes. The edits to `workflow`,
   `qa` and `settings` are described here, the way the original spec edited the packed gate.
8. **Checks are per package.** A wrong box belongs to one package, and QA confirms packages one at a time.
9. **Every box scan adds a package**, as **Add package** with that box does, since the UI always creates a package
   with its box. Changing a box stays a tap, which is what `BOX_NOT_SCANNED` watches for. Tapping isn't removed,
   so a dead scanner doesn't stop packing.
10. **One warehouse-wide mode per check.** With six boxes and one store, per-box or per-product exceptions are
    complexity nobody would use.
11. **Over max can't be turned off.** It's a physical limit. Its warn mode is the old decision 3 (the packer's
    reason). Block mode needs an approval, which closes the self-override gap.
12. **Partial dimensions are enough for `NO_FIT`.** The bulky items cause the costly mistakes, and they're the
    ones worth measuring. The fit test is shared with the suggestion.
13. **Re-weigh can block.** This replaces decision 5 only when the check is set to block. On off it behaves
    exactly as decision 5 says.
14. **Custom sizes are flagged, not exempt.** They're fit-checked against the typed size and trip
    `CUSTOM_DIMENSIONS`. They have no min or max to compare against.
15. **No "bigger than suggested" check.** It needs every item measured, and its mistake costs postage rather than a
    carrier adjustment. `UNDER_MIN` roughly covers over-boxing.
16. **Trips are saved when packing ends.** QA sees what the packer saw, and settings changes don't rewrite it.
    Force-status still saves them, so skipping the gate doesn't hide anything.
17. **Going back to Packing clears trips and box confirmations**, the same way a repack clears verification. The
    contents may change.
18. **A box barcode can never be mistaken for a product.** Otherwise a scan could add a package when the packer
    meant to pack an item.
19. **QA acknowledges every trip, and box confirmation is a setting** (off, when tripped, always). Confirming the
    box acknowledges the box-related trips so QA doesn't tap twice. Without an acknowledgement, the yellow card
    would be easy to ignore.
20. **Start on warn and measure first.** Everything starts on warn except `BOX_NOT_SCANNED` (off until barcodes
    are entered). The 30-day counts show when a check trips rarely enough, and correctly enough, to set to block.
21. **The estimate threshold is a setting** (5–100%, default 25), replacing `WEIGHT_WARNING_RATIO`.
22. Recorded in `docs/decisions.md` in the same PR as the code.

### Amendment 2 (approved 2026-11-24, from the box-picker grilling)

23. **An amendment to packing, not a new module.** Groups only exist for the pack screen's picker. The new
    preference is added to `identity`'s user preferences, the way A1 edited `qa`'s screen.
24. **Columns are a per-user preference** in the account menu, saved on the user next to language and theme, so
    they follow the person to any station. 1 or 2, default 1. It isn't a toggle inside the picker.
25. **A box is in at most one group.** Being in several groups would show the same box twice.
26. **One group order for everyone, set by an Admin with Move up / Move down.** That's everyone's shared mental
    map of the shelves. Buttons work by keyboard and on a tablet without a drag-and-drop library.
27. **Groups are display only.** The suggestion, checks, box barcodes, carriers and QA ignore them.
28. **Boxes inside a group stay A–Z by name**, as the whole list is today. No manual order within a group.
29. **Ungrouped boxes come last, under "Other boxes".** With no groups the picker has no headings and looks as it
    does today.
30. **The suggestion is shown once, first, full width and highlighted** with a border and the badge (not colour
    alone). It isn't repeated in its group. The split and unknown messages stay at the top, as today.
31. **Deleting a group ungroups its boxes.** Groups hold no history, so there's no archive for them.
32. **Two columns drop to one below 480 px**, so names and dimensions don't wrap badly on a phone in portrait.
    Tablets keep two in both orientations.
33. **A group with nothing to show is hidden** in the picker, including one whose only box is the suggestion.

## Open questions

1. *(A1)* **A product barcode that arrives later and matches a box barcode.** Box admin refuses a barcode a
   product already has, but `store-sync` could later import a product with the same code. The pack screen checks
   box codes first, so that product couldn't be scanned in, only tapped. Options: have sync log a warning and
   show a banner on Boxes (recommended), or accept the risk for six barcodes we control.
