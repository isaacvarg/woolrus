# Spec: `lumexia`

**Milestone:** M5 · **Depends on:** `settings` (`lumexiaBaseUrl`, `lumexiaApiKey`, `getIntegrationConfig`),
`packing` (packages, `PackageItem`, the pack screen and its scan field, the **packed** gate), `qa` (the QA screen,
the **verified** gate, purchase preconditions), `notes` (internal notes), `operations` (the health pattern) ·
**Used by:** `returns` (which lot came back, later), `reporting` (lot reports, later) · **State:** planned

Project-wide commands, structure, code style, testing levels and boundaries are in [`../../SPEC.md`](../../SPEC.md);
this spec only adds what is specific to `lumexia`.

## Objective

Record which Lumexia lot every lot-tracked unit shipped from, so a recall or a customer complaint can be traced
from a lot to the orders that received it, and from an order to its lots. Lumexia is our ERP and the source of
items and lots; Woolrus links its products to Lumexia items, captures lots at Packing, and checks them against
Lumexia in the background so the floor never waits on it.

- **Source:** `docs/decisions.md` § Scope ("Lot traceability + SKU↔item link now; stock sync later"). The SRS has
  no lot requirements; this spec is the requirement.
- **Users:** Admins (`lumexia.manage`) link products and choose which kinds of Lumexia item need a lot. Packers (`order.pack`) capture
  lots. QA (`order.qa`) sees lot status and fixes rejected lots. Everyone with `order.read` sees lots on an order
  and can look a lot up.
- **Why now:** M4 is live, so orders ship through Woolrus; lot capture can only start once they do. The schema
  already reserved `Product.lumexiaItemId` and `PackageItem.lotCode/lumexiaLotId`, and Settings already stores the
  Lumexia URL and key.

### User stories

1. As an admin, in **Settings → Lumexia → Lot rules** I see three lists fetched from Lumexia (item types,
   procurement types and inventory types), each value with a switch. Inventory types Lumexia tracks are marked
   "Tracked in Lumexia". I turn on the item type **Production base**: every product linked to a production-base
   item now needs a lot.
2. I open **Lumexia items**. Every product is listed with its SKU, its Lumexia link (or "Not linked"), its item
   type and whether it needs a lot. I press **Match by SKU**; Woolrus proposes a Lumexia item for each product
   whose SKU equals an item's reference code or alias. I review the list and confirm the matches.
3. For a product whose SKU doesn't match, I search Lumexia items by name or reference code and pick one. For an
   exception, I can set one linked product to **Always needs a lot** or **Never needs a lot**, overriding the
   rule; **Follow lot rules** is the default.
4. As a packer, a lot-tracked line on the pack screen shows **Lot needed** once its units are in a box. I scan the
   lot label (the QR code or the printed lot number) with the package selected: all 3 gallons of X in that box
   are now lot A.
5. Then I notice one gallon has a different label and scan lot B. The card now shows "2 × A12A0124 · 1 ×
   B07C1124". Scanning B again makes it 1 × A, 2 × B. I can tap a lot to change its count or remove it.
6. I scan a lot from a different product by mistake. The scan is refused ("Lot BASE9999.… belongs to another
   item"), nothing is saved, and the order gets an internal note saying a lot for a different item was rejected.
7. **Complete packing** stays hidden while any lot-tracked unit has no lot ("1 line needs a lot"). Lumexia being
   down never stops me: lots are saved as **unverified** and checked later.
8. As QA, each row shows its lots with a status. A lot Lumexia doesn't know shows a warning ("Lot not found in
   Lumexia") but doesn't stop me. A lot that turns out to belong to a different item blocks the label purchase
   until I replace or remove it on the QA screen.
9. Anyone can search a lot number on **Lot lookup** and get every order, package and quantity that shipped it,
   with ship dates, and download it as CSV.

## Scope

**In:**
- A `LumexiaClient` adapter (HTTP + fake) and Lumexia health.
- Product ↔ Lumexia item links (`Product.lumexiaItemId`, reference code, item type), with the **Lumexia items**
  admin page, SKU matching and manual linking.
- **Lot rules:** a Settings section listing Lumexia's item types, procurement types and inventory types with a
  switch each; a product needs a lot when any of its item's three types is switched on, unless the product has an
  override.
- Lot capture at Packing: lot scans on the pack screen, the split rule, manual edits, and a new
  `PackageItemLot` table in place of `PackageItem.lotCode/lumexiaLotId`.
- The **packed** gate learns `lotMissing`.
- Background lot validation (pg-boss job + sweep), with statuses, notes, and the QA warning/block.
- QA can replace or remove a lot; the **verified** gate and purchase preconditions learn `lotWrongItem`.
- Lots on the order detail page, the pack drawer and the QA screen; **Lot lookup** with CSV export.
- Lumexia's side is built: the read-only REST API in [`../lumexia-api.md`](../lumexia-api.md) (decision 1). This
  module only calls it.

**Out (later or elsewhere):**
- Stock sync with Lumexia (decisions.md: "later"), and decrementing lot quantities when units ship.
- Creating lots in Lumexia from Woolrus (`POST /api/lots/create` exists but is the ERP's job).
- Lot capture at picking, or for products that don't need a lot.
- Lot expiry: not checked (no rule calls for it, and the API doesn't return it).
- Supplier lot numbers: never scanned. Every unit, bought-in goods included, carries a Lumexia lot label.
- Per-variation Lumexia items: variations use their parent product's link (decision 4).
- Returns by lot: `returns`. Lot reports beyond Lot lookup: `reporting`.

## Design

### Lumexia API (decision 1)

Woolrus talks to Lumexia's REST API under `/api/v1` with a per-user, read-only `lmx_` key sent as
`Authorization: Bearer` (created in Lumexia under Settings → User → Agents). The routes were built in the Lumexia
repo for this module; the as-built contract is [`../lumexia-api.md`](../lumexia-api.md). In short:

| Route | Woolrus uses it for |
|---|---|
| `GET /api/v1/health` | Health and **Test connection** (checks the key) |
| `GET /api/v1/item-types` (also `procurement-types`, `inventory-types`) | The lot-rule switches |
| `GET /api/v1/items?q=&reference_code=…&id=…&updated_since=` (paged) | Search, SKU matching in bulk, refreshing links |
| `GET /api/v1/items/{id}` | Linking one product |
| `GET /api/v1/lots/{id}` | Resolving a QR scan (the QR holds the lot's UUID) |
| `GET /api/v1/lots?lot_number=` | Validating a typed or printed lot number (may return several items' lots) |

`Item = { id, referenceCode, name, aliases, itemTypeId, procurementTypeId, inventoryTypeId, archived, updatedAt }`,
`Lot = { id, itemId, lotNumber, archived, createdAt }`, `LumexiaType = { id, name, archived }`; inventory types
add `isTracked: boolean`. Errors are `{ error: { code, message } }`.

What the as-built API means for Woolrus:
- **Types are tables with UUID ids** and are never archived (`archived` is always false). The type ids on an item
  are non-null in practice, but the schema allows null, so Woolrus does too.
- **`isTracked`** on inventory types is Lumexia's own idea of a tracked item. Woolrus shows it next to each
  inventory type as a hint, but it doesn't switch anything on by itself (decision 3).
- **Lots are never archived**, and an archived item's lots still appear. Validation doesn't look at `archived`.
- **No 429 yet**; Woolrus still treats 429 and 5xx as retry-later.
- **Aliases** are plain values and include other systems' ids (such as WooCommerce product ids), so a SKU match
  on an alias can hit the wrong item. `suggestLinks` labels alias matches ("matched alias LAV-BASE-1G") so the
  admin sees which ones to check, and it skips any SKU matching more than one item.
- **Dev port:** Lumexia's dev server defaults to :3000, which is Woolrus web's port. Run Lumexia on another port
  in dev (e.g. `http://localhost:3100`) and save that as the Lumexia URL in Settings.
- There are no recorded responses. The fixtures are written from the shapes above, and an opt-in live adapter test
  (`LUMEXIA_LIVE=1`, skipped in CI like the WooCommerce one) checks them against a dev Lumexia.

### Adapter (`packages/core/src/adapters/lumexia/`)

```ts
export interface LumexiaClient {
  ping(): Promise<void>;
  listTypes(kind: "item" | "procurement" | "inventory"): Promise<LumexiaType[]>; // follows nextCursor
  searchItems(q: string, limit?: number): Promise<LumexiaItem[]>;
  findItems(filter: { referenceCodes?: string[]; ids?: string[] }): Promise<LumexiaItem[]>; // batches of 200
  getItem(id: string): Promise<LumexiaItem | null>;
  getLot(id: string): Promise<LumexiaLot | null>;
  findLotsByNumber(lotNumber: string): Promise<LumexiaLot[]>;
}
```

- `http.ts` uses `fetch` with a 5 s timeout, parses every response with Zod (`schemas.ts`), and throws
  `LumexiaUnavailable` (network, timeout, 5xx, 429) or `LumexiaAuthError` (401/403). 404 → `null`; an empty list
  is `[]`. 400 is a bug on our side and is thrown as an internal error.
- `fake.ts` keeps types, items and lots in memory, for tests and for dev without a Lumexia running.
- `lumexiaClientFor(db)` builds the client from `getIntegrationConfig(db, "lumexia")`; it returns `null` when the
  URL or key isn't set. With no client, linking is unavailable, and lots are saved and stay unverified.
- **Health:** `/api/health` gains `lumexia: "ok" | "unconfigured" | "down"` (a `ping()` call, cached 30 s), following SPEC-operations. Unlike WooCommerce, `down` doesn't make the endpoint fail: the floor works
  without Lumexia.

### Lot numbers and scans (`packages/core/src/lumexia/codes.ts`, pure)

Lumexia lot numbers are `<item reference code>.<letter><2 digits><month A–L><DD><YY>`, e.g. `BASE1234.A12A0124`.
The label's QR code encodes the lot's UUID, not the number.

- `parseLotCode(raw)` trims and uppercases, then returns `{ kind: "number", lotNumber, referenceCode }` when it
  matches `^([A-Z0-9-]+)\.([A-Z]\d{2}[A-L]\d{4})$`, `{ kind: "uuid", id }` for a UUID, else `null`.
- The pack screen's single scan field asks `parseLotCode` first. A lot code goes to `scanLot`, anything else to
  `packing`'s `scanIntoPackage` as today. A product barcode can't look like either, so nothing is ambiguous.
- **Offline item check:** a lot *number* names its item. If the reference code doesn't equal the line's
  `Product.lumexiaItemRef`, the lot belongs to a different item, and that's known without calling Lumexia. A UUID
  needs Lumexia: `scanLot` tries `getLot` with a 2 s budget and falls back to saving it unverified.

### Schema additions (ask-first, approved with this spec)

```prisma
model Product {
  // existing: lumexiaItemId String? @map("lumexia_item_id")
  lumexiaItemRef            String?   @map("lumexia_item_ref")   // reference code, e.g. BASE1234
  lumexiaItemTypeId         String?   @map("lumexia_item_type_id") @db.Uuid
  lumexiaProcurementTypeId  String?   @map("lumexia_procurement_type_id") @db.Uuid
  lumexiaInventoryTypeId    String?   @map("lumexia_inventory_type_id") @db.Uuid
  lumexiaSyncedAt           DateTime? @map("lumexia_synced_at") @db.Timestamptz(3)
  /// null = follow the lot rules; true/false = this product always/never needs a lot.
  lotOverride               Boolean?  @map("lot_override")
}

model Settings {
  // existing fields …
  /// Lumexia types whose items need a lot (Settings → Lumexia → Lot rules). An item needs one if any matches.
  lumexiaLotItemTypeIds        String[] @default([]) @map("lumexia_lot_item_type_ids") @db.Uuid
  lumexiaLotProcurementTypeIds String[] @default([]) @map("lumexia_lot_procurement_type_ids") @db.Uuid
  lumexiaLotInventoryTypeIds   String[] @default([]) @map("lumexia_lot_inventory_type_ids") @db.Uuid
}

enum LotStatus { UNVERIFIED VALID NOT_FOUND WRONG_ITEM }

model PackageItemLot {
  id            String    @id @default(uuid(7)) @db.Uuid
  packageItemId String    @map("package_item_id") @db.Uuid
  lotNumber     String?   @map("lot_number")      // null only for a UUID scan not yet resolved
  lumexiaLotId  String?   @map("lumexia_lot_id")
  quantity      Int                                 // CHECK > 0 (hand-written)
  position      Int                                 // scan order; 0 is the default lot
  status        LotStatus @default(UNVERIFIED)
  scannedById   String?   @map("scanned_by_id") @db.Uuid
  scannedAt     DateTime  @default(now()) @map("scanned_at") @db.Timestamptz(3)
  checkedAt     DateTime? @map("checked_at") @db.Timestamptz(3)
  // relations to PackageItem (onDelete: Cascade) and User (SetNull)
  @@unique([packageItemId, lotNumber])
  @@unique([packageItemId, lumexiaLotId])
  @@index([lotNumber])
  @@index([status])
  @@map("package_item_lots")
}
```

- `PackageItem.lotCode`, `PackageItem.lumexiaLotId` and their index are **dropped** (always null today). One row
  per lot per box line replaces them, because a box line can hold several lots.
- The type ids are stored as Lumexia returns them, without a foreign key: types live in Lumexia, and Woolrus
  only fetches their names to show.
- There's no data to migrate: nothing runs in production yet, so dev databases are simply reset
  (`pnpm --filter @woolrus/db exec prisma migrate reset`, then `pnpm db:seed`) if a migration edit needs it.
- A unique index on `products.lumexia_item_id` isn't added: two Woo products can be the same Lumexia item.
- Σ `PackageItemLot.quantity` ≤ `PackageItem.quantity` is enforced in core (every write locks the order row), not
  by SQL.

### Lot rules and linking (`packages/core/src/lumexia/{rules,items}.ts`)

All need `lumexia.manage` (Admin). The ones that call Lumexia also need a configured client
(`errors.lumexia.unconfigured`) and map `LumexiaUnavailable` to `errors.lumexia.unavailable`.

| Operation | Behaviour |
|---|---|
| `getLotRules()` | `listTypes` for all three kinds, joined with the three Settings lists: `{ itemTypes, procurementTypes, inventoryTypes }`, each `{ id, name, needsLot, isTracked? }[]` plus `unknownIds` (switched-on ids Lumexia no longer returns, shown as "Removed in Lumexia" so they can be switched off). Lumexia down → the saved ids are returned without names, and the switches are read-only. |
| `setLotRules({ itemTypeIds, procurementTypeIds, inventoryTypeIds })` | Replaces the three lists (UUIDs, not checked against Lumexia, so it works offline). Audited `settings.lumexiaLotRules` with before/after. |
| `searchLumexiaItems({ q })` | Passes through to `searchItems`. |
| `suggestLinks()` | Takes every unlinked product's SKU and calls `findItems({ referenceCodes })`, which matches reference codes and aliases case-insensitively. Returns `{ productId, item, matchedOn: "referenceCode" \| "alias" }[]`; writes nothing. A SKU matching more than one item is left out. |
| `linkProduct({ productId, itemId })` | Reads the item, then sets `lumexiaItemId/Ref`, the three type ids and `lumexiaSyncedAt`. Audited `product.lumexiaLink`. |
| `linkProducts({ links })` | Same, for up to 200 confirmed suggestions in one transaction (one `findItems({ ids })` call). |
| `unlinkProduct({ productId })` | Clears the link fields and `lotOverride`. Lots already captured stay. |
| `setLotOverride({ productId, lotOverride: true \| false \| null })` | Requires a link (`errors.lumexia.notLinked`). Audited. |

A line **needs a lot** when it is physical, its product is linked, and either `lotOverride` is `true`, or
`lotOverride` is `null` and **any** of the product's item type, procurement type or inventory type is in the
matching Settings list (`needsLot(product, settings)`, pure, in `rules.ts`). Rules and overrides are read live, so a change affects
orders still in Packing; orders past Packing aren't re-gated (QA's gate doesn't check `lotMissing`).

Variations have no link of their own: a line for any variation uses its parent product's link (decision 4).
`store-sync` already leaves `lumexia*` fields alone; it learns to leave `lotOverride` alone too. A daily
`lumexia.refreshItems` job re-reads linked items with `findItems({ ids })` and updates their reference code and
type ids, so an item moved to another type in Lumexia follows the rules from the next day. An item Lumexia no
longer returns keeps its last values and shows "Not found in Lumexia" on the admin page.

### Capturing lots (`packages/core/src/lumexia/lots.ts`)

Each operation runs like a `packing` operation: `assertCan(actor, "order.pack")`, lock the order row, order in
`PACKING`, live claim held, `touchClaim`, `recordAudit(entityType: "PackageItem", action: "lot.<op>")`,
`notifyOrderChanged`. Lots don't affect rates, weights or QA verification, so nothing is invalidated.

| Operation | Input | Result |
|---|---|---|
| `scanLot` | `packageId`, `code`, `scanId` | Parses the code (not a lot → `errors.lumexia.notALot`). Picks the target box line: the package's lot-needing lines for the lot's item (by reference code for a number; for a UUID, the item from Lumexia, else every lot-needing line in the package). No candidate → `errors.lumexia.lotNotOnPackage`. Several (two variations of one item in one box) → `errors.lumexia.chooseLine` with the candidates; the client asks and retries with `packageItemId`. A number whose reference code isn't the line's → **rejected** (below). Otherwise applies the split rule. Idempotent on `scanId`. |
| `setLotQuantity` | `lotId`, `quantity` | Sets one lot's count; the difference comes from or goes to the default lot. Can't take the default below 1 or the total above the box line's quantity (`errors.lumexia.lotQuantity`). |
| `removeLot` | `lotId` | Its units go to the default lot. Removing the default makes the next lot by `position` the default and gives it the units; removing the only lot leaves the line needing a lot. |

**The split rule (decision 2).** A box line's lots always cover all its units once it has any lot:
- **First lot scanned** → one row with the box line's whole quantity. That is the **default lot**.
- **Scanning a lot already on the line** → one more unit moves to it from the default lot.
- **Scanning a new lot** → a new row with 1 unit, taken from the default lot.
- **The default lot has 1 unit left** → the unit is taken from the lot with the most units (ties: earliest
  `position`). When every lot has 1 unit, the scan is refused with `errors.lumexia.allUnitsHaveLots` ("All 3 units
  already have a lot; tap a lot to change it").
- **Packing changes the box line:** `packUnits`, `packRemaining` and `scanIntoPackage` add units to the default
  lot. `unpackUnits` removes from the default lot down to 1, then from the latest-scanned lot. When a box line
  reaches 0, its lots go with it (cascade). Units moved to another box don't carry their lot; that box asks for
  one. These are edits to `packing/service.ts`, made here.

**Rejected lot (different item).** When `scanLot` knows the lot belongs to another item, either from the number's
reference code or from Lumexia for a UUID, it writes nothing to the line and refuses with
`CONFLICT errors.lumexia.lotWrongItem` `{ lotNumber, itemRef }`. In a separate transaction it writes one internal
note on the package (`notes`' `createTextNote`): "Lot BASE9999.A12A0124 (item BASE9999) was scanned for
<product> and rejected: it belongs to a different item." The note is written even though the scan fails, so
it isn't rolled back with it.

### Gates

- **packed** gains one condition per box line that needs a lot and has no lots:
  `unmet("lotMissing", { line, package })`. `GateSnapshot` lines gain `needsLot`; package items gain `lotUnits`.
  Unverified, not-found and wrong-item lots all satisfy it: validation never blocks Packing (decision 5).
- **verified** gains `unmet("lotWrongItem", { line, package, lotNumber })` for every `WRONG_ITEM` lot.
  `purchasePreconditions` gets it with the rest of the gate, so no label is bought for it. `forceStatus` skips gates
  for admins, as today.
- `NOT_FOUND` and `UNVERIFIED` never block. The QA screen shows them as warnings.

### Validation (`packages/core/src/lumexia/validate.ts`, worker job `lumexia.validateLots`)

- Every lot write enqueues `lumexia.validateLots { packageItemLotIds }` in the same transaction (`enqueue(tx, …)`).
  A sweep every 10 minutes re-queues `UNVERIFIED` lots older than 5 minutes, so lots saved while Lumexia was down
  or unconfigured get checked once it's back.
- For each lot: resolve it (`getLot` for an id, `findLotsByNumber` for a number), then:
  - a lot on the line's item → `VALID`; fill in whichever of `lotNumber` / `lumexiaLotId` was missing;
  - only on other items → `WRONG_ITEM`, plus the same internal note as a rejected scan (once per lot);
  - nowhere → `NOT_FOUND`.
  Each sets `checkedAt`, is audited by a new `lumexia` system actor, and notifies the order.
- `LumexiaUnavailable` → the lot stays `UNVERIFIED` and pg-boss retries (5 attempts, exponential back-off from 30 s);
  the sweep covers anything left after that. `LumexiaAuthError` fails the job without retrying, so it shows on
  the failed-jobs page.
- `NOT_FOUND` lots are re-checked by the sweep once a day for 7 days (a lot can be created in Lumexia after the
  unit was labelled), then left as they are.
- Validation keeps running after the order leaves QA. A lot found `WRONG_ITEM` after a label was bought only gets
  the note and a flag on the order; nothing is undone.

### QA fixes (`packages/core/src/lumexia/lots.ts`)

`qaReplaceLot({ lotId, code, scanId })` and `qaRemoveLot({ lotId })` need `order.qa`, an order in `QA` and the QA
claim. Replace scans a new lot into the same box line with the same quantity (same item check, same rejection
note) and deletes the old row; remove gives the units to the default lot, as at Packing. This is how a
`WRONG_ITEM` block is cleared without sending the order back to Packing.

### Reads and UI

- **Contracts** (`packages/contracts/src/lumexia.ts`): `LotDto { id, lotNumber, lumexiaLotId, quantity, status,
  isDefault }`; package items in the pack, QA and order-detail reads gain `needsLot` and `lots: LotDto[]`.
- **Pack screen:** a lot-needing card shows **Lot needed**, or its lots as chips ("2 × A12A0124"), each with a
  status icon + word. Tapping a chip opens a small dialog to change the count or remove it. A refused scan shows
  its message in the scan banner, like product scans. A **Which line?** dialog handles `chooseLine`.
- **QA screen:** lots under each row; a `WRONG_ITEM` lot is marked as blocking with **Replace lot** / **Remove**;
  `NOT_FOUND` and `UNVERIFIED` show as warnings.
- **Order detail and pack drawer:** lots per package item, with status.
- **Settings → Lumexia:** the existing card gains **Test connection** (`ping`) and a **Lot rules** section with
  three groups (Item type, Procurement type, Inventory type), one switch per value from `getLotRules`. Inventory
  types Lumexia tracks carry a "Tracked in Lumexia" tag. Ids no longer in Lumexia get a **Switch off** action.
  A line under the groups says "A product needs a lot if any of its types is switched on". Saving calls
  `setLotRules`.
- **Lumexia items** (`/lumexia`, Admin): product table (TanStack Table) with link, item type name and a
  **Needs lot** column (Yes / No, plus "override" when set), filters (linked / unlinked / needs lot), **Match by
  SKU** review dialog, an item search combobox per row, and a three-way **Lot** select (Follow lot rules / Always /
  Never). Shows "Lumexia isn't configured" with a link to Settings when there's no client.
- **Lot lookup** (`/lots`, `order.read`): one field (lot number, or a scan of the QR code); results are
  `lookupLot({ code })` → orders with number, customer, package, product, quantity, lot status and shipped date;
  **Download CSV** uses `core/csv.ts`. The lookup matches on `lotNumber`, or `lumexiaLotId` for a UUID.
- All strings in `en` and `es`.

### Permissions

`lumexia.manage` is new and goes to Admin. Lot capture uses `order.pack`, the QA fixes use `order.qa`, and Lot
lookup uses `order.read`.

## Success criteria

1. **Adapter:** the HTTP client maps fixtures for every route in `lumexia-api.md`, follows `nextCursor`, batches
   `findItems` by 200, returns null on 404 and [] on an empty list, raises `LumexiaUnavailable` on
   timeout/5xx/429 and `LumexiaAuthError` on 401/403; the fake passes the same contract tests; the opt-in live
   test passes against a dev Lumexia.
2. **Health:** `/api/health` reports `lumexia` as `unconfigured`, `ok` or `down`, and `down` doesn't fail the
   endpoint. **Test connection** reports the same.
3. **Lot rules:** `needsLot` is true for a linked physical product when any of its three types is switched on,
   or its override is `true`, and false for an override of `false` or an unlinked product (unit tests over the
   table of cases). Switching a type on makes an order already in Packing need lots. `getLotRules` lists all three
   kinds with their switches and `isTracked`, reports unknown ids, and works read-only when Lumexia is down.
4. **Linking:** `suggestLinks` matches SKUs to reference codes and aliases case-insensitively, skips ambiguous
   SKUs and writes nothing; `linkProduct` stores the reference code and all three type ids; unlink clears the
   override and keeps lots; the refresh job updates type ids; store sync leaves `lotOverride` and every `lumexia*`
   field alone; every operation is Admin-only (allowed + forbidden tests).
5. **Codes:** `parseLotCode` accepts `BASE1234.A12A0124` and UUIDs, rejects product barcodes, and splits out the
   reference code; the pack scan field routes lots and products correctly.
6. **Split rule:** first scan covers all units; a second lot takes 1 from the default; re-scanning moves 1 more;
   a default at 1 takes from the largest lot; a full split refuses the scan; pack/unpack adjust lots as specified;
   Σ lots never exceeds the box line's quantity (property test over random sequences).
7. **Wrong item:** a lot number for another item is refused with nothing saved on the line and exactly one
   internal note on the package, even though the scan failed.
8. **Gates:** **packed** fails with `lotMissing` until every lot-needing box line has a lot, through `/api/v1`
   too; **verified** and the purchase fail with `lotWrongItem` for a `WRONG_ITEM` lot; `NOT_FOUND`/`UNVERIFIED`
   never block.
9. **Offline:** with Lumexia down or unconfigured, lots are saved `UNVERIFIED` and packing completes; when it
   comes back, the sweep validates them.
10. **Validation:** `VALID`, `NOT_FOUND` and `WRONG_ITEM` are set as specified, missing ids/numbers are filled in,
    a `WRONG_ITEM` writes one note, and auth errors fail without retrying.
11. **QA fixes:** replacing or removing a `WRONG_ITEM` lot clears the block; both need `order.qa` and the claim.
12. **Lot lookup:** finds every package item that shipped a lot by number or UUID; CSV matches the screen.
13. **E2E (tablet):** pack a 3-unit lot-tracked line, scan lot A then B, see "2 × A · 1 × B", complete packing;
    at QA a wrong-item lot blocks **Complete QA** until it is replaced.
14. Migration drops the old `PackageItem` lot columns and keeps the hand-written constraints; `migrate:check` green.

## Decisions

1. **REST, not MCP.** Woolrus calls new read-only REST routes added to Lumexia under `/api/v1`, with a bearer
   `lmx_` key, rather than Lumexia's MCP endpoint. MCP is built for agents: its tool outputs are text with no
   stable schema and can change without notice, while a server integration needs a contract it can parse with Zod
   and test against fixtures. The Lumexia agent builds the routes from [`../lumexia-api.md`](../lumexia-api.md);
   Woolrus starts against the fake until they exist.
2. **One lot covers the whole box line until a second is scanned**, and further scans split one unit at a time
   (the user's rule). Lots live in their own table because one box line can hold several.
3. **Lot rules live in Woolrus, by Lumexia type.** Admins switch on the item types, procurement types and
   inventory types that need lots (the item type Production base, to start); any match is enough. Types are
   UUIDs, so names are fetched, never matched as text. Lumexia's `isTracked` on inventory types is shown as a hint
   but switches nothing by itself, so turning on lot capture stays an explicit choice. A per-product override
   covers exceptions. Rules are read live rather than copied onto products, so switching a type changes every
   product of that type at once.
4. **Variations use the parent's link.** Lumexia has one item for the parent product, not one per variation.
5. **Record now, validate later.** Lumexia being down never blocks the floor. The one thing caught at scan time
   without Lumexia, a lot number for another item, is refused at once.
6. **Wrong item blocks QA; unknown lot only warns** (the user's rule). A lot Lumexia doesn't know yet may simply not
   have been entered; a lot for another item is a mix-up.

## Open questions

None. The Lumexia API is built (see *Lumexia API*), and lot rules cover all three type properties.
