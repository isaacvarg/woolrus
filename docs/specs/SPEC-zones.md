# Spec: `zones`

**Milestone:** M6 · **Depends on:** `workflow` (the state machine and gates it makes zone-aware), `identity` (users,
roles), `store-sync` (import, where rules run), `picking`, `packing`, `qa` (their queues and next-order helpers) ·
**Used by:** `freight` (freight-mode zones, the freight area) · **State:** spec draft · **Issue:** [#229](https://github.com/isaacvarg/woolrus/issues/229)
the spec issue is created)_

Project-wide commands, structure, code style, testing levels and boundaries are in [`../../SPEC.md`](../../SPEC.md);
this spec only adds what is specific to `zones`.

## Objective

Split the warehouse into **fulfillment zones**. A zone is a separate area of work with its own stage order, its
own shipping mode and its own queues on the tablet. Every order belongs to exactly one zone. An Admin sends an
order to a zone by hand, or sets up rules that place orders when they are imported.

Today every order runs the same chain (Pending → Picking → Packing → QA → Ready → Completed) on the same screens.
Freight and pallet orders show up in the parcel staff's Pending, Picking and Packing queues, which confuses them,
and those orders don't need rate quotes or labels. Zones fix both problems. Each zone's orders appear only in that
zone's area, and a zone can use a different stage order and skip label purchase. `freight` builds the freight
shipping work on top of this module.

- **SRS:** none. This is new capability (M6, beyond v1). It extends FR-WF-\* (state machine, queues) and
  FR-LIST-\* (queues, All Orders).
- **Users:** Admins set up zones, zone rules and each user's zones. Floor staff work only in the zones they are
  given.
- **Background:** grilling session 2026-11-24 (decisions below). SPEC-store-sync's note on pallet orders ("booked by
  hand and recorded") is fulfilled by `zones` and `freight` together.

### User stories

1. As an Admin, I create a **Freight** zone with stage order *pick → QA → pack* and shipping mode *freight*, and
   give two warehouse staff access to it.
2. As an Admin, I add a zone rule: "shipping method contains `Freight` **and** order weight ≥ 150 lb → Freight".
   Matching orders land in Freight when they are imported. Every other order lands in Standard.
3. As an Admin, I open an order in Standard and choose **Move to zone → Freight** with the reason "customer asked
   for a pallet". It leaves the Standard queues and appears in Freight's Pending.
4. As a picker with access only to Standard, I never see a freight order in my Pending, Picking, Packing or QA
   queues.
5. As a picker with access to both, I see a zone switcher at the top of the tablet. The Freight area shows Pending,
   Picking, QA, Packing in that order, and its "Next order" only hands me freight orders.
6. As an Admin, I search All Orders and see a **Zone** column and a zone filter across every zone.

## Scope

**In:**
- `Zone`: name, position, stage order, shipping mode, archived flag. A built-in **Standard** zone (pick → pack →
  QA, carrier labels) that can't be archived or deleted. Existing orders are backfilled into it.
- `Order.zoneId` (required), and how the order got there (default, rule, or manual).
- **Zone rules:** an ordered list of rules, each with conditions ANDed together and a target zone. They run once,
  when an order is first imported. The first match wins, and no match means Standard.
- **Moving an order** to another zone by hand (Admin, reason required, audited), with the rules for where it
  lands.
- **Zone-aware workflow:** the state machine and gates take the order's zone (stage order and shipping mode) into
  account. This includes the *pick → QA → pack* order and the *freight* shipping mode (no rates, no labels).
- **QA before packing:** QA checks items against the picked lines when the zone's stage order puts QA first.
- **Pallets** in packing: a package of kind `PALLET` with typed dimensions and weight, in zones whose shipping
  mode is freight.
- **Zone access per user** and zone areas on the tablet: per-zone queues, counts, late flags and "Next order";
  zone column and filter on All Orders, search and the dashboard.
- Admin UI: Settings → Zones (zones, rules), user edit (zones), order page (Move to zone).

**Out (owned elsewhere or later):**
- Everything after packing for freight orders: the Freight board, booking, pickup, the customer note, the invoice
  and placards. That's `freight`.
- Binding a *station* to a zone. Access follows the signed-in user. It can be added later if a physical area needs
  it.
- Free-form stage builders, extra stage kinds, or zones without picking or QA.
- Re-running rules on re-sync or on rule edits. Rules place new orders only.
- Per-zone SLA thresholds, per-zone priority rules and per-zone reports (reports get a zone filter only where
  noted).

## Design

### Zone model (`packages/core/src/zones/`)

| Field | Meaning |
|---|---|
| `name` | Unique among unarchived zones, e.g. "Standard", "Freight". |
| `position` | Order in the zone switcher and settings list. |
| `stageOrder` | `PICK_PACK_QA` or `PICK_QA_PACK`. |
| `shippingMode` | `CARRIER_LABELS` (today's rates and labels) or `FREIGHT` (booked outside Woolrus, see `freight`). |
| `isDefault` | Exactly one zone (Standard) is the default. It can't be archived, and its stage order and shipping mode are fixed. |
| `archivedAt` | Archived zones keep their history. They can't receive orders or be chosen in rules. |

**Allowed combinations:** `PICK_PACK_QA + CARRIER_LABELS`, `PICK_PACK_QA + FREIGHT`, `PICK_QA_PACK + FREIGHT`.
Carrier labels require QA after packing, because QA chooses rates and buys labels for packed packages.
`PICK_QA_PACK + CARRIER_LABELS` is refused (`errors.zones.labelsNeedPackBeforeQa`).

**Changing a zone:** its `stageOrder` and `shippingMode` can only change while it has no open orders (every
status except COMPLETED and CANCELLED). This avoids orders whose flow changes under them. A zone with open orders
can't be archived (`errors.zones.hasOpenOrders`). Zones are never deleted.

### Placing orders (`zones/rules.ts`, `zones/assign.ts`)

`ZoneRule`: `name`, `enabled`, `position`, `zoneId`, `conditions` (JSON, 1–5 conditions, all must match).

Condition types, a Zod union in `packages/contracts/src/zones.ts`:

| Type | Matches when |
|---|---|
| `lineItem` | Any active line has this exact SKU, or this name ignoring case (the same as priority rules) |
| `shippingMethod` | The order's shipping method contains the text, ignoring case (the same as priority rules) |
| `itemQuantity` | The total active units across physical lines is ≥ N |
| `orderWeight` | The total line weight from the stored product weights is ≥ X lb. Lines with no weight count as 0. |

The `lineItem` and `shippingMethod` matchers are shared with `workflow/priority.ts` (moved to a pure
`workflow/conditions.ts` that both use), so the two kinds of rule can't drift apart.

**When rules run:** once, inside the import transaction that first creates the order (`sync/orders.ts`,
`sync/apply.ts`). Enabled rules are tried in `position` order. The first whose conditions all match sets the zone,
and no match gives the default zone. The order records `zoneSource` (`DEFAULT`, `RULE`, `MANUAL`) and `zoneRuleId`.
Re-syncs, external changes and rule edits never move an existing order. A **Test** button in the rule editor shows
which zone each of the 20 latest orders would get.

Rule CRUD, reorder and test need `zone.manage` and are audited.

### Moving an order (`zones/move.ts`)

`moveOrderToZone(db, actor, { orderId, zoneId, reason, version })` needs `order.moveZone` (Admin) and a
reason. It is audited with both zone names.

- **Refused** when the order is COMPLETED or CANCELLED, when it has any live label (`errors.zones.liveLabels`,
  void first), or when `freight` reports the order as booked (`errors.zones.freightBooked`). `freight` provides
  that check.
- **Finished work is kept:** picks, packages, QA checks. The order lands on the **first stage of the new zone's
  order that the order hasn't completed**, worked out from its stage events and gates:
  - Not yet picked → PENDING (or stays PICKING if picking is under way, with the claim kept).
  - Picked, not packed, not QA'd → the new zone's stage after picking.
  - Already packed for parcels and moving to a freight zone → back to PACKING, so boxes become pallets. Packages
    are kept for the packer to change.
  - Already in or past QA with carrier labels: rates and selected rates are cleared, since freight doesn't use
    them.
  - ON_HOLD orders keep the hold. `heldFromStatus` is recomputed the same way.
- The live claim is released when the order changes status. Live updates notify both zones' queues.

### Zone-aware workflow (amends `workflow`)

The transition table in `workflow/machine.ts` becomes a function of the zone's flow:
`transitionsFor({ stageOrder, shippingMode })`. `transition()` reads the order's zone with the order. The
`TransitionKind` names stay the same, so stage modules don't change how they call workflow.

| Kind | `PICK_PACK_QA + CARRIER_LABELS` (today) | `PICK_QA_PACK + FREIGHT` | `PICK_PACK_QA + FREIGHT` |
|---|---|---|---|
| `beginPicking` | PENDING → PICKING | same | same |
| `completePicking` | PICKING → PACKING, gate `picked` | PICKING → **QA**, gate `picked` | PICKING → PACKING |
| `completeQa` | QA → READY, gate `verified` | QA → **PACKING**, gate `itemsVerified` | QA → READY, gate `verifiedNoLabels` |
| `completePacking` | PACKING → QA, gate `packed`, fetches rates | PACKING → **READY**, gate `palletsPacked`, no rates | PACKING → QA, gate `palletsPacked`, no rates |
| `ship` | READY → COMPLETED, gate `shippable` | not allowed: `freight` adds `pickedUp` | not allowed |
| `repack` | READY → PACKING, gate `noLiveLabels` | same. `freight` resets the booking | same |
| hold / resume / cancel / force | unchanged | unchanged | unchanged |

New gates in `workflow/gates.ts`, using the existing snapshot:

- `itemsVerified`: every active physical line has `qaVerifiedQuantity` equal to its picked quantity, and no
  Critical issue is open. Blocking packing-check trips don't apply yet, since there are no packages.
- `palletsPacked`: `packed`, plus every live package is a `PALLET` with length, width, height and weight set. When
  `freight`'s "require placards" setting is on, it also needs placards printed and marked applied. `freight`
  provides that check through a gate hook, so `workflow` doesn't depend on `freight`.
- `verifiedNoLabels`: `verified` without the rate and label checks, and items checked per package as today.

`ship` and `shippable` don't change for carrier-label zones. Freight zones complete through `freight`'s `pickedUp`
kind, which `freight` adds to the table with its own gate.

### QA before packing (amends `qa`)

In a `PICK_QA_PACK` zone, QA verifies against the **picked lines**, since there are no packages yet:

- `OrderItem.qaVerifiedQuantity` (0…picked quantity, CHECK) plus `qaVerifiedAt` and `qaVerifiedById`. This is the
  same idea as `PackageItem.qaVerifiedQuantity`, at line level.
- The QA screen looks the same. Its item list comes from the picked lines instead of packages. The rate and label
  sections are hidden whenever the zone's shipping mode is `FREIGHT`, in either stage order.
- Tap, scan, wrong-scan handling, issue reporting and lot checks use the same code paths. `qa/verify.ts` gains a
  line-level target next to the package-item target.
- "Complete QA" in a freight zone makes the `completeQa` move only. It requests no purchase and runs no cost
  guard.

### Pallets (amends `packing`)

- `Package.kind`: `BOX` (default) or `PALLET`.
- A pallet has no `boxId`. `lengthIn`, `widthIn`, `heightIn` and `weightOz` are required and typed by the packer
  every time. There are no presets and no scale.
- In a zone whose shipping mode is `FREIGHT`, the packing screen offers only **Add pallet**. In carrier-label zones
  only boxes are offered, as today. The server refuses the wrong kind (`errors.packing.kindNotAllowed`).
- Items are assigned to pallets with the existing split and merge (`PackageItem`). The box suggestion, box checks
  and rate fetch are skipped for pallets. Packing checks that only apply to boxes don't trip.
- The label "Package 2 of 3" reads "Pallet 2 of 3" for pallets.

### Zone access (amends `identity`)

- `UserZone(userId, zoneId)`: the zones a user works in. New users get the default zone. Admins implicitly have
  every zone and don't need rows. It is set on the user edit page (needs `user.manage`) and audited.
- **What access gates:** reading a zone's queues and counts, "Next order" helpers, and starting or claiming stage
  work (`beginPicking`, pack and QA claims) on that zone's orders return `FORBIDDEN` without it. `order.read` and
  All Orders still show every zone, as today. Hold, notes and issues work on any order a user can read.
- Station-only users have zones too, set by the Admin like their roles.

### Queues and UI (amends `workflow` queries and the app shell)

- `listQueue`, `queueCounts`, `lockNextPending`, `lockNextPacking` and QA's next-order take a required `zoneId`.
- The tablet nav shows the current zone's stages in that zone's order (Freight: Pending, Picking, QA, Packing;
  Standard: Pending, Picking, Packing, QA, Ready). A **zone switcher** appears only for users with more than one
  zone. The last zone is remembered per user. Freight zones show no Ready entry: `freight` provides the Freight
  board instead.
- Routes take the zone as a path segment: `/z/[zone]/queue/[stage]`, `/z/[zone]/pick`, and so on. Old URLs
  redirect to the user's current zone.
- All Orders, search and the dashboard tiles get a zone column or filter. The order page shows a zone badge and
  (Admin) **Move to zone**.
- Settings → **Zones**: list with position, create, edit, archive. **Zone rules**: ordered list, enable/disable,
  condition editor, Test.

### API (oRPC, `packages/contracts/src/zones.ts`)

`zones.list`, `zones.create`, `zones.update`, `zones.archive`, `zones.reorder`, `zoneRules.list`,
`zoneRules.create`, `zoneRules.update`, `zoneRules.delete`, `zoneRules.reorder`, `zoneRules.test`,
`orders.moveZone`, `users.setZones`. Queue and next-order procedures gain `zoneId`.

### Permissions

| Permission | Who |
|---|---|
| `zone.manage` | Admin: zones and zone rules |
| `order.moveZone` | Admin |

### Schema additions (approved with this spec)

- `enum StageOrder { PICK_PACK_QA PICK_QA_PACK }`, `enum ShippingMode { CARRIER_LABELS FREIGHT }`,
  `enum ZoneSource { DEFAULT RULE MANUAL }`, `enum PackageKind { BOX PALLET }`.
- `Zone`, `ZoneRule`, `UserZone`: new tables in `schema/zones.prisma`.
- `Order.zoneId` (required, FK Restrict, indexed with `status`), `Order.zoneSource`, `Order.zoneRuleId` (FK SetNull).
- `OrderItem.qaVerifiedQuantity` (default 0, CHECK 0…picked), `qaVerifiedAt`, `qaVerifiedById`.
- `Package.kind` (default `BOX`). A hand-written CHECK requires a `PALLET` to have no `boxId`.
- Migration: create Standard (`isDefault`), set every order's `zoneId` to it, then make the column required.
  Give every existing user a Standard `UserZone` row. A partial unique index allows only one `isDefault` zone.

### Files expected to change

`packages/core/src/zones/{service,rules,assign,move,access}.ts` (+ tests), `packages/core/src/workflow/{machine,
gates,service,queries,priority,conditions}.ts`, `packages/core/src/sync/{orders,apply}.ts`,
`packages/core/src/picking/complete.ts`, `packages/core/src/packing/{complete,service}.ts`,
`packages/core/src/qa/{verify,complete,scan}.ts`, `packages/core/src/permissions.ts`,
`packages/core/test/factories.ts`, `packages/contracts/src/{zones,orders,packing,qa,users}.ts`,
`apps/web/src/server/router.ts`, `apps/web/src/lib/{queues,live}.ts`, `apps/web/src/app/(app)/{queue-nav,
drawer-nav,dashboard}.tsx`, `apps/web/src/app/(app)/z/[zone]/**` (queue, pick, pack, qa routes moved under the
zone), `apps/web/src/app/(app)/settings/zones/**`, `apps/web/src/app/(app)/users/**`,
`apps/web/src/app/(app)/orders/**`, `packages/db/prisma/schema/{zones,orders,shipping}.prisma` + migrations,
`packages/db/prisma/seed*.ts` (a Freight zone with a few dev orders), `packages/i18n/src/messages/{en,es}.json`,
`apps/web/e2e/zones.spec.ts`.

## Success criteria

1. **Backfill:** after migrating, every order is in Standard with `zoneSource = DEFAULT`, every user has Standard,
   and Standard can't be archived or have its flow changed.
2. **Combinations:** creating or updating a zone as `PICK_QA_PACK + CARRIER_LABELS` is refused. Changing the stage
   order or shipping mode of a zone with an open order is refused, and so is archiving it.
3. **Rules:** pure tests cover each condition type, AND of several conditions, position order (first match wins),
   disabled rules skipped, and no match → default. An import test places a new order by rule and records
   `zoneSource = RULE` and the rule. A re-sync of the same order after a rule change leaves its zone alone, and so
   does a re-sync after a manual move.
4. **Move:** tests move an order from each status (PENDING, PICKING, PACKING, QA, READY without labels, ON_HOLD)
   between Standard and a `PICK_QA_PACK` freight zone and check where it lands, what is kept and what is cleared.
   A live label, a booked freight order, a COMPLETED order and a missing reason are each refused. The move is
   audited with both zones.
5. **Machine:** for each allowed flow, a table test walks every kind from every status and checks the move or
   `illegalTransition`. The carrier-label flow behaves exactly as before, and the existing workflow tests pass
   unchanged.
6. **Gates:** `itemsVerified` fails with an unverified line and with an open Critical issue. `palletsPacked` fails
   with a box in a freight zone, a pallet missing a dimension or weight, or an unassigned unit. `verifiedNoLabels`
   passes without rates or labels.
7. **QA before pack:** in a freight zone the QA screen lists picked lines, scans verify them, and no rates are
   fetched or labels bought at any point (API and job tests).
8. **Pallets:** adding a box in a freight zone or a pallet in a carrier zone is refused on the server. Items split
   and merge across pallets as with boxes.
9. **Access:** a user without a zone gets `FORBIDDEN` on its queues, counts, next-order and claims (API test for
   each), while All Orders and the order page still show it. Admins see every zone.
10. **UI:** one Playwright test: a rule sends a new order to Freight. A Standard-only picker doesn't see it. A
    freight picker picks it, QA verifies lines, the packer builds two pallets with items. The order reaches READY
    with no rates fetched. An Admin moves another order between zones from the order page.
11. Every new procedure has an allowed and a forbidden test.

## Assumptions

1. There are few zones (under 10) and few zone rules (under 50). Evaluating rules in memory at import is fine.
2. Product weights in the catalog are good enough for an "order weight ≥ X" rule. A missing weight counting as 0
   can only under-place, never over-place.
3. Per-user access is enough. Stations are shared and staff switch with their PIN, so the zone list follows the
   person.
4. The freight crew uses the same roles (Picker, Packer, QA). A zone decides *where* someone works, not *what*
   they may do.

## Decisions (2026-11-24, grilling session)

1. **Two modules**, `zones` then `freight`. Zones is the general mechanism. Freight is the first non-standard
   shipping mode.
2. **A small allowed set**, not free reordering: two stage orders times two shipping modes, minus the combination
   that can't work. Every zone picks and QAs.
3. **One zone per order**, Standard by default and backfilled.
4. **An Admin can move an order** until a label exists or freight is booked. Finished work is kept, and the order
   lands on the first stage not yet done.
5. **Rules run once, at import.** First match wins, no match is Standard, and a manual move is never overwritten.
   Conditions are ANDed, and the types are SKU or name, shipping method, quantity ≥ N, and weight ≥ X lb.
6. **Each zone is its own area** on the tablet, with its own queues. Staff see only their zones (per user, not per
   station). All Orders and search still show everything.
7. **Freight zones pack pallets only.** A pallet is a package (items assigned to it), and its dimensions and weight
   are typed every time.
8. **QA in a freight zone checks items only**, against picked lines when QA comes before packing.

## Open questions

1. **Moving a packed parcel order into Freight** sends it back to Packing to turn boxes into pallets. Is that
   right, or should an Admin be able to keep the boxes (freight that ships loose cartons)? Decision 7 says pallets
   only, so the spec sends it back.
2. **Dashboard tiles:** one set per zone, or totals with a zone filter? The spec uses a filter.
