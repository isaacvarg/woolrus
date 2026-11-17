# Spec: `picking`

**Milestone:** M2 · **Depends on:** `workflow` (transitions, claims, gates, live updates), `notes` (line notes) ·
**Used by:** `exceptions` (calls `reconcilePick` after a void or unvoid), `packing` (reads what was picked and
substituted), `reporting` (pick events) · **State:** done; amendment 1 (suggested batches, approved 2026-11-16)
is **planned** (tickets #191–#193) · **Issue:** [#23](https://github.com/isaacvarg/woolrus/issues/23); amendment 1:
[#190](https://github.com/isaacvarg/woolrus/issues/190)

> **Amendment 1 (approved 2026-11-16): suggested batches.** **Pick together** already collapses a batch into one
> stop per product, but the picker chooses the orders by eye, so a batch only saves walking when they happen to
> tick orders that share products. The warehouse has no bin locations, so shared products are the only way to
> save trips today.
>
> - **Suggestions.** A few cards (three by default, an admin setting) sit above the Pending queue. Each one is built from the oldest or most
>   urgent order that's left, filled with the Pending orders that share the most products with it.
> - **Limits.** A suggestion stays within the cart's order count (`pickBatchMaxOrders`) and a new cart weight
>   limit (`pickBatchMaxWeightOz`, default 200 lb).
> - **The picker decides.** **Pick these** creates the batch through the existing `createBatch`. **Select these**
>   ticks the orders in the queue so the picker can adjust them first. Nothing is created automatically.
>
> **Dependencies.** Only what `picking` already uses: `workflow`'s queue order and claims, `settings`, and product
> weights from `store-sync`. Two settings and no new tables. Everything marked *(A1)* below belongs to this
> amendment.

Project-wide commands, structure, code style, testing levels and boundaries are in [`../../SPEC.md`](../../SPEC.md);
this spec only adds what is specific to `picking`.

## Objective

Give the picker a tablet screen that gets the right items off the shelf: one big card per line, tap or scan to
mark it picked, a clear way to say "we don't have it" or "I put this in instead", and a list that walks several
orders at once. Every pick is checked and recorded on the server, so packing and QA start from what was really
taken.

- **SRS:** FR-PICK-01…06, FR-WF-04 (picker and time per item), NFR-PERF-02 (instant toggles), NFR-UX-01/04/05.
  Fixes SRS §7.1 #14 (the "Go To Pending" label) and the picking half of #16 (Out of Stock and Substituted can't
  be set).
- **Users:** Pickers (`order.pick`); Admins also link barcodes. Everyone else reads.
- **Why now:** `workflow` routes `beginPicking` / `completePicking` but there is no way to mark a line picked, so
  no order can pass the **picked** gate except by `forceStatus`.

### User stories

1. As a picker, I tap **Begin Picking** on a Pending order and get its pick screen: a card per line with the
   image, name, SKU, size/pack and checkout options, and the quantity in large type. Lines are in shelf order.
2. I tap a card and it turns green and drops to the bottom; tapping again undoes it. For a line of 6, a stepper
   lets me record 4 so far.
3. I scan the jar with the Bluetooth scanner. The matching card counts one more and flashes green. If I scanned
   the wrong product, the screen goes red, says what I scanned, and nothing changes.
4. A line isn't on the shelf. I mark it **Out of Stock** with how many I did find and a short note. The order
   can't leave Picking until that line is voided or substituted, and the screen says so.
5. I put the 16 oz jar in instead of the two 8 oz jars. I mark the line **Substituted**, type what went in
   instead, and it counts as picked. Packing and QA see the substitution on the line.
6. When every line is done I choose where to go: **Done** takes me back to the Pending queue (§7.1 #14), **Done,
   next order** begins and opens the next unclaimed Pending order, and **Done, open in Packing** (if I can pack)
   claims the order for me in Packing so I pack it myself.
7. As a picker with a cart, I tick six Pending orders and tap **Pick together**. They all become mine at once, or
   none do and I'm told which one someone else took. The batch list shows each product once with its total and
   which slots it goes to; when I scan it, the screen tells me "Slot 3 · #26237".
8. As an admin, I scan a product whose barcode Woolrus doesn't know. The screen offers **Link this code to
   Lavender soap 8 oz**; from then on that barcode matches everywhere.
9. *(A1)* As a picker, I open the Pending queue and the top card reads "6 orders · 14 items · 5 stops · 38 lb ·
   oldest #26201, 2 days · Gallon X ×5, Lavender soap ×3". I tap **Pick these**, and all six become mine in
   Batch 43. If someone else took one first, I'm told who, and the cards are rebuilt without it.
10. *(A1)* The second card has an order I know is waiting on a customer call. I tap **Select these**, untick that
    order in the queue and tap **Pick together** for the rest.
11. *(A1)* As an admin, I set the cart weight limit to 60 lb in **Settings → General**. Suggestions stop adding
    orders once the next one would go over 60 lb.

## Scope

**In:**
- Line pick operations in core: pick (full or a quantity), unpick, scan, out of stock, substitute, and the
  reconciliation `exceptions` calls after voids.
- Code matching (barcode or SKU) and an admin action to link an unknown barcode to a product or variation.
- Pick batches: a `PickBatch` table, creating a batch that begins picking every member order all-or-none, the
  aggregated batch pick list, batch scanning that assigns a unit to a slot, removing an order from a batch, and
  completing members.
- Pick order: bin location, then name, then SKU.
- UI: the single-order pick screen, multi-select and **Pick together** on the Pending queue, the batch screen, a
  **My picks** list (my open batch and my orders in Picking), and pick status on the order detail page.
- Schema: `PickBatch`, `PickBatchOrder`, one setting, one permission. Listed under *Schema additions*.
- *(A1)* Suggested batches: a pure grouping function, a read that runs it on the current Pending orders, the
  cards on the Pending queue with **Pick these** and **Select these**, and two settings, `pickBatchMaxWeightOz`
  and `pickBatchSuggestionCount`.

**Out (owned elsewhere or later):**
- Voiding a line (the way out of Out of Stock): `exceptions`, M3. Until then a picker substitutes, or puts the
  order on hold with a reason (FR-WF-06), and an admin can force it on.
- Changing stock in WooCommerce or Lumexia when something is out of stock: not planned.
- Entering bin locations: the store keeps none (SPEC-store-sync decision 1). Sort still uses them if sync ever
  fills them.
- A product admin page (barcodes, bins, customs). Only the scan-to-link action is built here.
- The packing screen: `packing`. Until it exists, **Done, open in Packing** opens the order detail page.
- Requiring a scan before a line counts as picked. Tapping stays allowed (decision 1).
- *(A1)* Creating or claiming batches automatically, including a "Done, next batch" finish option. Suggestions
  are only offered (A1 decision 4).
- *(A1)* Checking weight on a hand-picked **Pick together**. The picker can see their own cart.
- *(A1)* Zones, aisles or learned walk order. Grouping uses shared products only until products have locations.
- *(A1)* Volume or dimension limits on the cart. Weight is the only limit besides order count.
- *(A1)* Storing suggestions or counting how often they're used. Batches made from a suggestion are ordinary
  batches, which `reporting` can already count.

## Design

### Pick rules (`packages/core/src/picking/service.ts`)

Every line operation runs in one transaction that:
1. `assertCan(actor, "order.pick")`.
2. Locks the order row (`SELECT … FOR UPDATE`, after reading Settings, as `workflow` does). The order must be
   `PICKING` (`CONFLICT` / `errors.picking.notPicking`) and the actor must hold its live claim
   (`errors.workflow.claimRequired`). The line must belong to the order and be physical with active quantity > 0
   (`errors.picking.lineNotPickable`).
3. Writes the line: `pickStatus`, `pickedQuantity`, `pickedById`, `pickedAt`, `substitutionNote`.
4. `touchClaim`, `recordAudit(entityType: "OrderItem", action: "pick.<op>", before, after)` and
   `notifyOrderChanged` so other screens refresh.

Pick writes **don't bump `Order.version`**. The claim already means one person writes these lines, the row lock
orders them against transitions, and bumping on every tap would make the picker's own `completePicking` fail as
stale after a burst of optimistic taps. Transitions keep checking `expectedVersion` as before.

| Operation | Input | Result |
|---|---|---|
| `pickLine` | `itemId`, `quantity?` (1…active, default active) | `PICKED` when quantity = active, else `PENDING` with that partial count. From `OUT_OF_STOCK` or `SUBSTITUTED` it replaces that state. Picked by/at = actor/now. |
| `unpickLine` | `itemId` | `PENDING`, 0, clears picked by/at and `substitutionNote`. |
| `scan` | `orderId`, `code`, `scanId` | Resolves the code (below) to a line of this order that still needs units and adds 1. Idempotent on `scanId` (`withIdempotency`): a replayed scan doesn't count twice. |
| `markOutOfStock` | `itemId`, `foundQuantity` (0…active − 1), `note` (1–500) | `OUT_OF_STOCK`, `pickedQuantity = foundQuantity`, plus an internal note on the line. `idempotencyKey` (it creates a note). |
| `substitute` | `itemId`, `substitute` (1–200), `note?` (≤500) | `SUBSTITUTED`, `pickedQuantity = active`, `substitutionNote = substitute`, plus an internal note on the line ("Substituted: …"). `idempotencyKey`. |

A tap on a card is `pickLine` (full) when the line isn't `PICKED`, else `unpickLine`. The stepper sends `pickLine`
with a quantity. The client applies each result optimistically and rolls back on error (NFR-PERF-02: server
confirm under 300 ms p95).

**Line notes.** `notes` gains `createTextNote(tx, actor, { orderId, orderItemId, content })`: an internal,
text-only note written inside the caller's transaction, with the same `note.write` check and audit as
`createNote`. Photos can be added afterwards from the line's note composer.

**Reconciliation (contract with `exceptions`).** `reconcilePick(tx, itemId)` recomputes a line after its active
quantity changes, without a claim check (the caller has its own permission):
- `pickedQuantity > active` → clamp to active.
- `OUT_OF_STOCK` with `pickedQuantity = active` → `PICKED` (the missing units were voided).
- `PENDING` with `pickedQuantity = active > 0` → `PICKED` (the units still to pick were voided).
- `PICKED` with `pickedQuantity < active` (a void was undone) → `PENDING`.
- `SUBSTITUTED` → `pickedQuantity = active`.
`exceptions` calls it in the same transaction as each void and unvoid. Store-sync's quantity edits already refuse
going below the picked count (`belowPicked`), so they need nothing from here.

### Code matching (`packages/core/src/picking/codes.ts`)

A scanner in HID mode types the code and Enter into the focused page. The client collects keystrokes into a
buffer (a code ends on Enter; keys more than 50 ms apart start a new buffer, so normal typing in a note field isn't
taken as a scan) and sends the code.

`codesForLine(line)` → the normalized (trimmed, upper-cased) set of: variation barcode, product barcode,
variation SKU, product SKU, line SKU. In `scan`:
- Lines of the order whose codes contain the scanned code, in pick order. The first one with
  `pickedQuantity < active` and status `PENDING` gets the unit.
- No line matches → `CONFLICT` / `errors.picking.scanNotOnOrder`. If the code matches a known product or
  variation elsewhere, the error carries its name ("That's Lavender soap 16 oz"); otherwise
  `errors.picking.scanUnknown` with `canLink: true` for callers with `product.manage`.
- Lines match but all are done → `errors.picking.scanAlreadyPicked` with the line name.
- A refused scan changes nothing and isn't audited.

**Linking a barcode** (`linkBarcode({ orderItemId, code })`, `product.manage`): sets `barcode` on the line's
variation if it has one, else its product. Refused with `CONFLICT` when the code is already another
product's or variation's barcode or SKU (`errors.picking.codeInUse`, with that product's name). Audited
(`product.linkBarcode`, before/after). Store-sync never overwrites `barcode` (SPEC-store-sync SC 9).

### Pick order (`packages/core/src/picking/sort.ts`, pure)

`pickOrder(lines)`: bin location ascending with natural number order (`A2` before `A10`), lines without a bin
after those with one, then name (case-insensitive), then SKU, then line id. Non-physical lines and lines with
active quantity 0 aren't shown; the screen says "1 line voided" instead. On screen, done lines (`PICKED`,
`SUBSTITUTED`) move below the rest; `OUT_OF_STOCK` stays at the top until resolved.

### Pick batches (`packages/core/src/picking/batches.ts`)

A batch is one picker's walk through up to `Settings.pickBatchMaxOrders` orders (one cart, default **10**). It's stored so it survives a reload or a
change of tablet and so `reporting` can count batch picks later.

- **Create** `createBatch({ orders: [{ id, expectedVersion }], idempotencyKey })`, 2 to `pickBatchMaxOrders` orders
  (`errors.picking.batchTooLarge` with the limit). In one
  transaction, orders locked in id order: each order must be `PENDING` (it's begun with workflow's
  `transition(tx, … beginPicking)`) or already `PICKING` with the actor's live claim. All or none: failures are
  reported per order like `claimMany` (`claimedByOther` with the holder's name, `stale`, `illegalTransition`).
  The actor can have one open batch (`errors.picking.batchOpen`).
- **Slots** 1…N are given by queue order (priority desc, ordered at asc) and never renumbered.
- **Membership** is live while the member order is `PICKING` with the batch owner's live claim. An order that was
  completed, held, cancelled, forced or taken over has **left** the batch: it's shown greyed with why, and
  nothing in the batch acts on it. That keeps `workflow` unaware of batches. `removeFromBatch({ batchId,
  orderId })` lets the owner drop an order on purpose (it stays in Picking, still claimed).
- **Closing:** a batch closes (`closedAt`) when the owner finishes it, or on the next batch read or write once no
  member is live. Adding an order to a new batch removes it from any other open batch.
- **Batch list** `getBatch({ id })`: lines of the live members grouped by what's on the shelf (variation, else
  product, else normalized SKU, else name), in pick order. Each group shows image, name, SKU, the total still to
  pick, and one chip per member line: slot, order number, quantity, its own attributes when they differ, and its
  state. Reading needs `order.read`; acting needs ownership and `order.pick`.
- **Batch scan** `scanBatch({ batchId, code, scanId })`: like `scan`, across the live members by slot order. The
  first member with a matching line that still needs units gets it. Returns `{ orderId, slot, itemId }` so the
  screen can show "Slot 3 · #26237" large. Same errors as `scan`.
- **Chips** call the same line operations as the single-order screen (they act on that order's line).
- **Complete** `completeBatchMembers({ batchId, orders: [{ id, expectedVersion }] })`: calls workflow's
  `completePicking` for each, each in its own transaction, and returns a result per order (moved, or the unmet
  gate list). One order failing its gate doesn't hold the others back. The screen offers **Complete ready
  orders** and a per-slot **Complete**.

### Suggested batches *(A1)* (`packages/core/src/picking/suggest.ts`, pure)

`suggestBatches(orders, limits)` takes the candidate orders (below) in queue order, with each one's pickable lines,
and returns up to `pickBatchSuggestionCount` suggestions (default **3**). Each order is in at most one suggestion.

- **Product key:** the same "what's on the shelf" key the batch list groups by (variation, else product, else
  normalized SKU, else name). It's shared with `getBatch`, not copied, so a suggestion's stop count matches the
  batch screen.
- **Line weight:** the variation's `weightOz`, else the product's, times the active quantity. A line with no
  weight counts as 0, and the suggestion counts it as missing a weight.
- **Building one suggestion:**
  1. **Start** from the first order still unused, in queue order (priority desc, ordered at asc, id). This is
     what keeps the oldest and most urgent orders first (A1 decision 1).
  2. **Grow:** from the orders still unused, take the one that shares the most product keys with the suggestion
     so far. Ties go by queue order. Skip any order that would go over `pickBatchMaxWeightOz` (when it's set).
     Only orders that share at least one product key can join.
  3. **Stop** at `pickBatchMaxOrders` orders, or when no order can join.
- **Single-order results:** if the first suggestion ends with one order, it's kept as a one-order card (its
  action is **Begin picking**), so the oldest order is always on top. Any later suggestion that ends with one
  order is dropped (unless it's `overWeight`, below), and that order isn't used as a starting order again.
  Building continues from the next order until there are `pickBatchSuggestionCount` suggestions or no orders are
  left.
- **An order over the limit by itself** starts a one-order suggestion flagged `overWeight`. It's never skipped.
- **Each suggestion returns:** the order ids with the `version` each was read at, in queue order; `units` (total
  active quantity); `stops` (distinct product keys); `weightOz` and `missingWeightCount`; the oldest member's
  number and `orderedAt`; and its top three shared products (key, name, total units, how many orders), most
  shared first. Shared products are the ones on two or more of its orders.

Pure and deterministic: the same input gives the same suggestions, so two pickers looking at the same queue see
the same cards. Tested as a pure function.

**Candidates** (`listSuggestionCandidates`, in `queries.ts`): the first **200** orders in queue order with status `PENDING`
and no live claim by someone other than the actor. Lines are read the way `getBatch` reads them, plus weights.
Of those, orders with no physical line of active quantity > 0 are then left out: there's nothing to walk for. So the
cap can leave fewer than 200 candidates, which a day's queue (A1 assumption 7) doesn't reach.

### Reads

- `getPickView({ orderId })`: the order header (number, customer, priority, claim, `version`), the customer note,
  the lines in pick order with everything on a card (image, name, SKU, attributes, active quantity, picked
  quantity, status, substitution, note count, bin), counts done/total, the **picked** gate's unmet list (computed
  by `workflow`'s gate, read-only), and the open batch the order is in, if any. `order.read`.
- **Completing a single order** `completePick({ orderId, expectedVersion, after: "queue" | "next" | "pack" })`
  (`after`, not `then`: an object with a `then` key reads as a promise) calls workflow's `completePicking`, then in the same transaction:
  - `queue`: nothing more; the client returns to the Pending queue.
  - `next`: begins picking the first Pending order in queue order without a live claim (`FOR UPDATE SKIP
    LOCKED`, so two pickers finishing at once never get the same one) and returns its id. With none left, it
    returns `null` and the client shows the empty Pending queue.
  - `pack`: needs `order.pack`; claims the order (now in Packing) for the actor with workflow's claim, and the
    client opens it for packing.
  A gate failure moves nothing, whichever `then` was asked.
- `myPicks()`: the actor's open batch and their live-claimed orders in Picking, for **My picks**. `order.read`.
- *(A1)* `getBatchSuggestions()`: loads the candidates and settings, then runs `suggestBatches`. It also returns
  `openBatch { id, number }` when the actor already has an open batch, because `createBatch` would refuse them.
  `order.pick`. Nothing is stored.
- `workflow`'s `getOrder` already returns pick status and quantity per line; the detail page shows them with the
  picker's name and time (FR-WF-04), and this module adds `pickedBy { name }` and `pickedAt` to `OrderLine`.

### API (oRPC, `packages/contracts/src/picking.ts`)

| Procedure | Route |
|---|---|
| `picking.view` | `GET /orders/{orderId}/pick` |
| `picking.pickLine` / `unpickLine` | `POST /order-items/{itemId}/pick`, `…/unpick` |
| `picking.markOutOfStock` / `substitute` | `POST /order-items/{itemId}/out-of-stock`, `…/substitute` |
| `picking.scan` | `POST /orders/{orderId}/scan` |
| `picking.linkBarcode` | `POST /order-items/{itemId}/link-barcode` |
| `picking.complete` | `POST /orders/{orderId}/complete-pick` |
| `picking.myPicks` | `GET /me/picks` |
| `pickBatches.create` | `POST /pick-batches` |
| `pickBatches.suggestions` *(A1)* | `GET /pick-batches/suggestions` |
| `pickBatches.get` | `GET /pick-batches/{id}` |
| `pickBatches.scan` | `POST /pick-batches/{id}/scan` |
| `pickBatches.removeOrder` | `POST /pick-batches/{id}/remove-order` |
| `pickBatches.complete` | `POST /pick-batches/{id}/complete` |
| `pickBatches.finish` | `POST /pick-batches/{id}/finish` |

Line operations return the updated `PickLine` and the order's done/total counts. `pickLine` / `unpickLine` are
absolute (set this state), so a replay is harmless; `scan` and `scanBatch` take a `scanId` because they add.

### Schema additions (approved with this spec)

One migration. The hand-written constraints at the end of the init migration are untouched; this one adds its own.

```prisma
model PickBatch {
  id          String    @id @default(uuid(7)) @db.Uuid
  number      Int       @unique @default(autoincrement())   // "Batch 42" on screen
  ownerId     String    @map("owner_id") @db.Uuid
  stationId   String?   @map("station_id") @db.Uuid
  createdAt   DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)
  closedAt    DateTime? @map("closed_at") @db.Timestamptz(3)
  owner       User      @relation(fields: [ownerId], references: [id], onDelete: Restrict)
  orders      PickBatchOrder[]
  @@index([ownerId, closedAt])
  @@map("pick_batches")
}

model PickBatchOrder {
  batchId   String    @map("batch_id") @db.Uuid
  orderId   String    @map("order_id") @db.Uuid
  slot      Int
  removedAt DateTime? @map("removed_at") @db.Timestamptz(3)   // dropped on purpose or moved to another batch
  batch     PickBatch @relation(fields: [batchId], references: [id], onDelete: Cascade)
  order     Order     @relation(fields: [orderId], references: [id], onDelete: Cascade)
  @@id([batchId, orderId])
  @@unique([batchId, slot])
  @@map("pick_batch_orders")
}
```

Hand-written SQL in this migration: `slot BETWEEN 1 AND 50` (the setting's ceiling); one open batch per owner (partial unique index on
`owner_id` where `closed_at IS NULL`); an order in at most one open batch (partial unique index on `order_id`
where `removed_at IS NULL`, with membership rows of closed batches marked removed on close).

Permission `product.manage` (Admin only) for `linkBarcode`.

`Settings.pickBatchMaxOrders Int @default(10)` (integer 2–50; 50 matches `claimMany`'s ceiling). Added to
`AdminSettings`, `PublicSettings` (the queue's **Pick together** limit), the update contract and the General
section of `/settings`. Lowering it doesn't touch batches already open.

*(A1)* `Settings.pickBatchMaxWeightOz Int? @default(3200) @map("pick_batch_max_weight_oz")`: the cart weight limit
for suggestions, in ounces (default 200 lb). `null` turns the limit off. When set, it must be between 16 and 8000
(1–500 lb), enforced in the contract and by a hand-written `CHECK` in its migration. It sits next to
`pickBatchMaxOrders` in `AdminSettings`, the update contract and **Settings → General**. The field is entered and
shown in the `weightDisplay` unit, like box weights. It isn't public, because only the server reads it. Changing
it only affects suggestions built after the change.

*(A1)* `Settings.pickBatchSuggestionCount Int @default(3) @map("pick_batch_suggestion_count")`: how many suggested
batches the Pending queue shows, an integer from 1 to 10 (contract and a hand-written `CHECK` in the same
migration). It sits next to the weight limit in `AdminSettings`, the update contract and **Settings → General**.
Like the weight limit, it isn't public.

### UI (`apps/web/src/app/(app)/`)

- **`pick/[orderId]`:** the pick screen. Header with order number, customer, priority, customer note, and
  done/total. Cards at least 160 px tall (NFR-UX-01) in one or two columns by width: image, name, SKU, attributes,
  bin, big quantity ("2 of 3"), status colour and icon (not colour alone, NFR-UX-05), note count. Tap toggles; a
  menu on each card has quantity, Out of Stock, Substituted, Unpick, Add note. Out of Stock and Substituted open
  React Aria dialogs. A scan result banner (green with the line, red with the reason, or the admin's **Link this
  code** button) with a short sound, announced through an `aria-live` region. Footer: **Done**, **Done, next
  order**, **Done, open in Packing** (only with `order.pack`), Hold. A refused completion shows the unmet gate list.
- **Pending queue:** row checkboxes (pickers only), **Pick together (n)** up to `pickBatchMaxOrders`, and a result panel listing
  orders that couldn't be taken.
- *(A1)* **Suggested batches** on the Pending queue, for `order.pick` users only, above the table:
  - **Cards:** up to `pickBatchSuggestionCount`, in a row that wraps (stacked on narrow screens). Each card shows the order count, items, stops,
    weight (in `weightDisplay`; "weight incomplete" when `missingWeightCount > 0`; an "over cart weight" badge for
    `overWeight`), the oldest order's number and age, and its shared products ("Gallon X ×5 · 3 orders").
  - **Pick these:** calls `pickBatches.create` with the card's ids and versions and opens the batch screen. On a
    refusal it shows the result panel **Pick together** already uses, then refetches the suggestions.
  - **Select these:** replaces the queue's ticks with the card's orders, so the picker can adjust them and use
    **Pick together**.
  - **One-order cards:** they show **Begin picking** instead of the two buttons above.
  - **Open batch:** if the picker already has one, the cards stay visible but their actions are disabled, with a
    link to "Finish Batch 42 first".
  - **Hidden:** with no suggestions, and while the queue is searched (search is for finding one order, not for
    planning a walk).
  - **Refreshing:** suggestions are refetched whenever the queue refreshes on order events.
- **`pick/batch/[id]`:** grouped lines with per-slot chips, the large slot callout on scan, a slot legend
  (slot → order, state, left/removed), **Complete ready orders**, per-slot Complete and Remove, **Finish batch**.
- **`pick` (My picks):** my open batch and my orders in Picking, each a link back to its screen. A **My picks**
  nav entry for `order.pick` users; **Begin Picking** in the queue and on the detail page now lands on the pick
  screen.
- **Order detail:** each line shows its pick status, picked quantity, substitution, and who picked it when.
- The pick screens follow the order's SSE events: a takeover or hold elsewhere shows a banner and disables the
  cards. All strings in `en` and `es`; toasts for results (NFR-UX-04).

### Dev data

`seedDemoOrders` gains a few products with barcodes, two lines sharing a variation across orders (to exercise
batch grouping), a line with quantity 6, and bins on some demo products so the sort is visible.

*(A1)* The demo Pending orders also include an overlapping set: orders with a heavy "5 gal pail" product (about 45 lb
each), three of them sharing a second product. Most demo products get weights, and one is left without. The queue
then shows a multi-order card, a card the weight limit cuts short at the default 200 lb, and "weight incomplete".

### Files expected to change

`packages/core/src/picking/{service,codes,sort,batches,queries}.ts` (+ tests), `packages/core/src/notes/service.ts`
(`createTextNote`), `packages/core/src/workflow/{service,detail}.ts` (export `transition` for batch create;
`pickedBy` on lines), `packages/core/src/{index,permissions}.ts`, `packages/core/src/settings/service.ts`, `packages/core/test/factories.ts`,
`packages/contracts/src/{picking,orders,settings,index}.ts`, `apps/web/src/server/router.ts`,
`apps/web/src/lib/scanner.ts`, `apps/web/src/app/(app)/{pick/**,queue/**,orders/[id]/**,settings/**,drawer-nav.tsx}`,
`packages/db/prisma/schema/{orders,auth,system}.prisma` + one migration, `packages/db/prisma/seed.ts` (demo data),
`packages/i18n/src/messages/{en,es}.json`, `apps/web/e2e/picking.spec.ts`.

*(A1)* `packages/core/src/picking/{suggest,queries,batches}.ts` (+ tests; the product key moves to a shared helper
`getBatch` and `suggestBatches` both use), `packages/core/src/settings/service.ts`,
`packages/contracts/src/{picking,settings}.ts`, `apps/web/src/server/router.ts`,
`apps/web/src/app/(app)/queue/[stage]/{suggested-batches,queue-table}.tsx`, `apps/web/src/app/(app)/settings/**`,
`packages/db/prisma/schema/system.prisma` + one migration, `packages/db/prisma/seed.ts`,
`packages/i18n/src/messages/{en,es}.json`, `apps/web/e2e/picking.spec.ts`.

## Success criteria

1. **Line rules:** each operation has an allowed test and is refused when the order isn't Picking, the actor
   doesn't hold the live claim, the line is from another order, non-physical or fully voided, or the quantity is
   out of range. A refused operation changes nothing.
2. **Gate:** an order whose lines are all `PICKED` or `SUBSTITUTED` passes **picked** and completes; one
   `OUT_OF_STOCK` or partial line blocks it with that line's message. Rush Order lines never need picking.
3. **Recording (FR-WF-04):** every pick write records picker and time on the line and one audit event with
   before/after. Pick writes leave `Order.version` unchanged and emit an `order_changed` event.
4. **Out of Stock / Substituted (FR-PICK-04):** each requires its text, writes exactly one internal line note
   (once, on replay of the same `idempotencyKey`), and sets the line as specified. A substitution shows on the
   order detail line.
5. **Scan (FR-PICK-06):** a scan matches by barcode, variation SKU, product SKU or line SKU, case- and
   whitespace-insensitive, and adds one unit to the first unfinished matching line. A replayed `scanId` adds
   nothing. A code from another product is refused naming it; an unknown code is refused with `canLink` only for
   Admins; a fully picked line is refused as already picked.
6. **Link barcode:** an Admin links a code to the line's variation (or product) and the next scan of it matches;
   a code already used by another product is refused; a Picker is forbidden.
7. **Reconcile:** each of the five `reconcilePick` cases is tested, including partial Out of Stock → void the rest
   → `PICKED` → order passes **picked**.
8. **Sort (FR-PICK-05):** bins sort naturally, lines without bins after, then name, then SKU; tested as a pure
   function.
9. **Finish options:** `after: "next"` begins the top unclaimed Pending order (two pickers finishing at once get different orders) or returns `null` when none is left; `after: "pack"` claims the order in Packing and is forbidden without `order.pack`; a gate failure moves nothing for any option.
10. **Batch create:** six Pending orders become Picking with the actor's claim and slots 1–6 in queue order, in one
   transaction; one order claimed by someone else makes none move and reports that order with the holder's name.
   More than `pickBatchMaxOrders` (tested at a lowered setting), or a second open batch, is refused. Concurrent creates over a shared order: exactly one succeeds.
11. **Batch list and scan:** a variation on three orders shows once with its total and three chips; scanning it
    fills slots in order and returns the slot; an order taken over or held elsewhere drops out of the list and
    out of scan assignment.
12. **Batch complete:** completing three members where one fails its gate moves two and reports the third's
    unmet list. A batch with no live members closes; the order-in-one-open-batch constraint holds.
13. **Permissions:** every procedure has an allowed and a forbidden test (e.g. a Packer can't pick, a Picker
    can't link a barcode, someone else can't act on my batch).
14. **Performance:** `pickLine` server time under 300 ms p95 in an integration benchmark (NFR-PERF-02); `getBatch`
    for 10 orders × 10 lines under 300 ms p95.
15. **E2E (desktop + tablet):** begin picking → tap, stepper, scan (simulated HID keystrokes) → a wrong scan shows
    red and changes nothing → Out of Stock blocks completion with the message → substitute → **Done, next order**
    opens the next Pending order in Picking and the first is in Packing. **Done** returns to the Pending queue;
    **Done, open in Packing** leaves the order in Packing claimed by the picker. Batch: select three Pending orders → Pick together → scan
    assigns slots → complete ready orders. A second browser taking over a batch order removes it from the
    batch screen without a reload.
16. Green: `pnpm lint && pnpm typecheck && pnpm test && pnpm build` plus Playwright.
17. *(A1)* **Grouping (pure):**
    - The first suggestion starts from the top order in queue order. A higher-priority order starts it ahead of
      an older one.
    - Orders that share more products join first, and ties go by queue order.
    - An order that shares nothing never joins.
    - Each suggestion has at most `pickBatchMaxOrders` orders. No order appears in two suggestions, and there are
      at most `pickBatchSuggestionCount`.
    - The same input always gives the same output.
18. *(A1)* **Weight:**
    - With a lowered limit (50 lb in the test), an order that would go over is skipped and a lighter matching order joins instead.
    - An order over the limit by itself is a one-order `overWeight` suggestion.
    - A product without a weight counts as 0 and is reported in `missingWeightCount`. A variation's weight is used
      before its product's.
    - With the limit off (`null`), weight never stops an order joining.
19. *(A1)* **One-order results:** a top order with no match is a one-order first card. A later suggestion that
    ends with one order is dropped and doesn't stop the next one being built. Stops, units, shared products and
    the oldest order are computed as specified, and stops match the group count `getBatch` shows for the same
    orders.
20. *(A1)* **Candidates and read:**
    - The candidates leave out orders that aren't Pending, orders with someone else's live claim, and orders with
      no pickable lines. Orders the actor has claimed are kept.
    - `getBatchSuggestions` reports the actor's open batch.
    - A Packer is forbidden.
    - The read takes under 300 ms p95 with 200 Pending orders × 5 lines.
21. *(A1)* **Settings:** `pickBatchMaxWeightOz` defaults to 3200 oz (200 lb). It accepts `null` and 16–8000,
    and refuses other values in the contract and the database. `pickBatchSuggestionCount` defaults to 3, accepts
    1–10 and refuses other values the same way. Only an admin can update either one. **Settings → General** shows
    the weight limit in the `weightDisplay` unit, and the queue shows as many cards as the count allows.
22. *(A1)* **E2E (tablet):**
    - With the A1 demo data, the Pending queue shows a multi-order card. **Pick these** opens a batch with exactly
      those orders in slots by queue order.
    - **Select these** ticks the card's orders. Unticking one and tapping **Pick together** creates a batch
      without it.
    - When a second browser claims one of a card's orders first, **Pick these** shows the refusal naming the
      holder, and the cards refresh without that order.

## Assumptions

1. A picker has one open batch at a time.
2. Scanners run in HID keyboard mode ending each code with Enter (decisions.md § Platform). No camera scanning.
3. A scan adds one unit; a case of 6 is scanned six times or entered with the stepper.
4. Out of Stock and Substituted notes are internal; nothing is told to the customer from picking.
5. Two lines can share a SKU (same variation, different checkout options); a scan fills them in pick order.
6. `exceptions` depends on `picking` for `reconcilePick`. The capability map lists `exceptions → workflow, notes`;
   it gains `picking` (already its order on the roadmap, and #23 already blocks #25).
7. *(A1)* There are 50–200 orders a day, and a few products show up in many of them. That's enough overlap for
   grouping to save walking, and few enough orders that the suggestions can be rebuilt on every read.
8. *(A1)* Product weights from `store-sync` are mostly filled in. Where they aren't, the card says so instead of
   guessing.

## Decisions (2026-10-21)

1. **Tap or scan:** tapping a card still picks it; a scan picks and confirms the item. No setting to require scans.
2. **Barcodes:** a scan matches barcode or SKU; an Admin can link an unknown scanned code to the line's product or
   variation from the pick screen. No product admin page.
3. **Batches are stored** (`PickBatch`, `PickBatchOrder`), so they survive a reload or a change of tablet.
4. **Out of Stock / Substituted notes** are internal line notes through `notes`; Substituted also keeps the short
   "what went in instead" text in `substitutionNote`.
5. **Batch size** is an admin setting, `pickBatchMaxOrders`, default 10, range 2–50.
6. **Finishing an order** offers three ways on: **Done** (back to the Pending queue), **Done, next order**
   (begins and opens the next unclaimed Pending order) and **Done, open in Packing** (claims it for the picker as
   packer, with `order.pack`).

### Amendment 1 (approved 2026-11-16, from the batch-grouping brainstorm)

1. **Oldest or urgent first.** Each suggestion starts from the top order still unused in queue order, and only
   orders that share products with it can join. Overlap decides who rides along, never who goes first. A
   suggestion that saves more walking but leaves the oldest order waiting is never offered.
2. **Weight is a cart limit for suggestions,** next to order count. Product weights already sync, and gallons fill
   a cart by weight before they fill its slots. Volume isn't checked.
3. **No locations needed.** Grouping uses shared products only. Zones or bins can be added to the ordering later
   without changing how a picker uses the cards.
4. **Offered, not automatic.** The picker taps a card, or adjusts it first. Woolrus never claims orders by itself.
   Suggestions are computed on read and never stored, so a batch made from one is just a batch.
5. **An amendment to picking,** not a module of its own. It's one read over picking's own batch grouping, plus
   two settings.
6. **Defaults** (answered at approval): the cart weight limit starts at **200 lb**, and the queue shows **three**
   cards. Both are admin settings, because carts and pickers differ.

## Open questions

None open.
