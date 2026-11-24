# Spec: `freight`

**Milestone:** M6 · **Depends on:** `zones` (freight-mode zones, pallets, the zone area), `workflow`, `packing`,
`qa`, `shipping` (the Woo push), `notes` (customer notes), `identity` (the new role), `settings` · **Used by:**
`rate-lab` (freight cost in Real orders spend) · **State:** planned (spec approved 2026-11-24; tickets #242–#251) · **Issue:** [#230](https://github.com/isaacvarg/woolrus/issues/230)

Project-wide commands, structure, code style, testing levels and boundaries are in [`../../SPEC.md`](../../SPEC.md);
this spec only adds what is specific to `freight`.

## Objective

Handle the shipping half of pallet orders. Freight is quoted and booked by phone or carrier portal, outside
Woolrus. Woolrus needs to show the scheduler which packed pallets are waiting, record what they booked (carrier,
cost, BOL) and let an Admin mark the order picked up. Only then does WooCommerce hear about it: status Completed,
the BOL as tracking, and a carrier-specific note to the customer that an Admin approves first, unless they switch
on auto-send.

It also prints the pallet paperwork: an **invoice** (generated in Woolrus, like the WooCommerce PDF attached
today) and optional **placards**, one per pallet, with the order number, customer, pallet count and order QR.

- **SRS:** none. This is new capability (M6). It fulfils SPEC-store-sync's note that pallet orders are "booked by
  hand and recorded (carrier, PRO number)".
- **Users:** **Scheduler** (new role) quotes and books freight. **Admin** sets up carriers and templates, marks
  pickup and approves the customer note. **Admin and QA** print the pallet paperwork (only they have printers) and
  hand it to the packer.
- **Background:** grilling session 2026-11-24. The invoice layout follows the WooCommerce invoice used today
  (order 27031 sample: store name, bill-to with email and phone, ship-to, order number, date, payment method, lines
  with SKU, weight, quantity and price, then subtotal, shipping, discounts, tax, total).

### User stories

1. As a Scheduler, I open **Freight board** and see every freight order whose packing is done: customer, ship-to,
   pallets with dimensions and weight, and booking status. Orders still being picked or packed aren't there yet.
2. I get a quote from DDS by phone, then open the order on the board, pick **DDS** from the carrier list and enter
   the cost, the BOL number and the pickup date. The order becomes **Booked**.
3. As an Admin, when DDS collects the pallets I press **Picked up**. The dialog shows the DDS message filled in with
   the customer's name and BOL. I fix a typo and press **Mark picked up and send**. Woo shows Completed, the BOL as
   tracking, and my note to the customer.
4. As an Admin, I switch **Customer note at pickup** to *Send automatically*. From then on, **Picked up** sends the
   carrier's message without asking.
5. As QA, I open **Pallet paperwork** in the Freight area, see an order whose two pallets were just saved, press
   **Print**, and take the invoice and two placards ("Pallet 1 of 2", "Pallet 2 of 2") to the packer.
6. As a Scheduler, a packer reopens a booked order and adds a third pallet. The order jumps to the top of my board
   marked **Re-quote needed**, and the Freight nav shows a count badge.
7. As an Admin, I add a carrier "Estes" with its own message template and an AST tracking provider, and archive a
   carrier we no longer use.

## Scope

**In:**
- The **Scheduler** role and freight permissions.
- **Freight carriers** (admin list) with optional tracking URL, AST tracking provider and customer note template.
  DDS is seeded with the current message.
- **Freight booking** per order: needs quote → booked → picked up, with carrier, cost, BOL, pickup date and quote
  reference. Re-quote when pallets change after booking.
- The **Freight board** in each freight zone's area.
- The **`pickedUp`** transition (READY → COMPLETED) and the Woo push for freight: status, BOL tracking, the
  customer note.
- The **customer note draft**: filled from the carrier template at booking, refreshed on change, reviewed in the
  Picked up dialog or auto-sent by setting, also sendable early from the order.
- **Pallet paperwork**: a list for Admin and QA, the **invoice** print page (any order), **placards** (optional),
  printed together or separately by setting.
- The optional **"require placards"** gate on finishing packing.
- **Freight settings** page: auto-send, require placards, print together.
- Freight cost in Rate Lab → Real orders spend, under the carrier's name.

**Out (owned elsewhere or later):**
- Getting freight quotes from carrier APIs, or buying freight in Woolrus.
- Email, push or Notion notifications to the scheduler. They're future work, and the board flag and badge are
  enough for now.
- Customs commercial invoices for international freight.
- Per-carrier auto-send switches.
- Packing slips for parcel orders (still out of scope in `shipping`). The invoice page is printable for any order,
  but nothing prints it automatically.

## Design

### Roles and permissions (amends `identity`)

New role `SCHEDULER`: `everyone` + `freight.book` + `invoice.print`.

| Permission | Admin | Scheduler | QA |
|---|---|---|---|
| `freight.manage`: carriers, templates, freight settings | ✓ | | |
| `freight.book`: see the board, enter and edit bookings | ✓ | ✓ | |
| `freight.pickup`: mark picked up, send or skip the customer note | ✓ | | |
| `freight.paperwork`: the Pallet paperwork list, print placards | ✓ | | ✓ |
| `invoice.print`: the invoice for any order | ✓ | ✓ | ✓ |

Scheduler is a role, not a zone. A Scheduler needs access to the freight zone (`zones`) to open its area, and the
board checks both.

### Freight carriers (`packages/core/src/freight/carriers.ts`)

`FreightCarrier`: `name` (unique among unarchived), `trackingUrl` (optional, with `{bol}`), `astProvider`
(optional AST tracking-provider name), `noteTemplate` (optional text), `archivedAt`. CRUD and archive need
`freight.manage` and are audited. Archived carriers stay on old bookings and can't be chosen for new ones.

**Template placeholders**, filled by a pure `renderFreightNote(template, context)`:
`{customer_first_name}`, `{customer_name}`, `{company}`, `{order_number}`, `{carrier}`, `{bol}`,
`{tracking_url}`, `{pickup_date}`, `{pallet_count}`, `{store_name}`. An unknown placeholder is refused when the
template is saved (`errors.freight.unknownPlaceholder`). An empty value renders as nothing. The template editor
shows a live preview against a sample order.

The seed creates **DDS Freight** with the current message as its template. The greeting "Good afternoon," stays as
typed. The dev seed uses it, and the production seed adds it only when no carrier exists.

### Booking (`freight/booking.ts`)

`FreightBooking` (one per order, created when a freight order first reaches READY):

| Field | Meaning |
|---|---|
| `status` | `NEEDS_QUOTE` → `BOOKED` → `PICKED_UP` |
| `requoteNeeded` | Set when pallets change after booking. It sends the order back to `NEEDS_QUOTE` and is cleared on the next booking. |
| `carrierId`, `costCents`, `currency` | Required to book. The currency comes from the order. |
| `bolNumber` | Required to book. Pushed to Woo as the tracking number. |
| `pickupDate` | Optional, a date only |
| `quoteRef`, `schedulerNotes` | Optional free text, internal only |
| `noteDraft`, `noteDraftEdited` | The customer note draft and whether an Admin edited it |
| `noteId` | The `Note` created when it was sent, if any |
| `bookedById/At`, `pickedUpById/At`, `version` | Who and when, plus optimistic locking |

- **Book / edit** (`freight.book`): validates the carrier, cost ≥ 0 and the BOL, moves `NEEDS_QUOTE` → `BOOKED`,
  and is audited with the before/after values. A booked order can be edited until it is picked up.
- **Re-quote:** a `repack` (READY → PACKING), any pallet added, removed or resized, or a hold-resume that reopens
  packing sends the booking back to `NEEDS_QUOTE` with `requoteNeeded`. The carrier, cost and BOL are kept as a
  starting point. It is audited, and the board updates live.
- `zones`' move check: an order whose booking is `BOOKED` can't change zone (`errors.zones.freightBooked`). This
  module provides that check.
- Cancelling an order cancels its booking. There's nothing to void, since freight is booked outside Woolrus.

### The customer note draft

- The draft is rendered from the carrier's template when the order is booked, and re-rendered when the carrier,
  BOL, pickup date or pallet count changes, **unless** an Admin has edited it (`noteDraftEdited`). In that case the
  Picked up dialog shows a warning that the booking changed since the edit, with **Reset to template**.
- No template means no draft, and nothing is sent.
- **Send early** (`freight.pickup`, from the order page): creates a `CUSTOMER` `Note` from the draft and pushes it
  to Woo right away through a new `woo.pushNotes` job, which reuses `notes/push.ts`. It is audited.
- **At pickup**, by the `Settings.freightNoteMode`:
  - `ASK` (default): the Picked up dialog shows the draft in an editor with **Mark picked up and send**,
    **Mark picked up without a note** and Cancel.
  - `AUTO`: the dialog shows the rendered note read-only, with a line saying it will be sent, and **Mark picked
    up**.
  - In both modes, a note already sent early isn't sent again.

### Picked up (amends `workflow` and `shipping`)

`freight` adds the transition kind **`pickedUp`**: READY → COMPLETED, permission `freight.pickup`, no claim,
gate `freightBooked` (the booking is `BOOKED` with carrier, cost and BOL, and `requoteNeeded` is false). It applies
only in zones whose shipping mode is `FREIGHT`, where `ship` isn't allowed (see `zones`).

`markPickedUp(db, actor, { orderId, version, note: { send: boolean, text?: string } })`, all in one
transaction:

1. Runs the `pickedUp` transition. The booking becomes `PICKED_UP`.
2. Creates the `CUSTOMER` note if one is to be sent, using the edited text or the template (`AUTO`).
3. Enqueues `woo.push` for the order.

`woo.push` (`shipping/woo-push.ts`) learns the freight case and keeps its idempotent read-then-post steps:

- Tracking: with AST on and the carrier having an `astProvider`, one AST item with the BOL. Otherwise one tracking
  note with the carrier name, the BOL and the tracking URL if any (the existing tracking-note path, fed by the
  booking instead of labels).
- Unposted notes, including the customer note, then status Completed. Retries and the failed-push banner are the
  same as for parcels.

### Freight board (`freight/board.ts`, UI in the zone area)

- Shown as **Freight board** in the nav of each zone whose shipping mode is `FREIGHT`, in place of Ready. It needs
  `freight.book` (and the zone).
- **Rows:** orders in that zone in READY (packing done) with a booking not `PICKED_UP`. Re-quote rows come first,
  then needs quote, then booked, oldest first within each group.
- **Columns:** order number, customer and company, ship-to city and state, pallets (count, and each L × W × H and
  weight), total weight, booking status, carrier, cost, BOL, pickup date, paperwork printed, note status (draft /
  sent / none).
- Opening a row shows the booking form, the pallet details, the customer note draft (read-only for Schedulers) and
  **Print invoice**. Admins also see **Picked up**.
- **Nav badge:** count of `requoteNeeded` plus `NEEDS_QUOTE` in that zone. It updates live.
- **Recently picked up:** a collapsed section with the last 7 days, read-only.

### Pallet paperwork (`freight/paperwork.ts`)

- **Pallet paperwork** list in the freight zone's area, for `freight.paperwork` (Admin, QA). It shows freight
  orders with at least one saved pallet whose paperwork hasn't been printed since the pallets last changed, plus a
  "Printed" tab for reprints.
- **Print modes** (`Settings.freightPrintTogether`, default on):
  - Together: one **Print paperwork** button that opens one print page with the placards first, then the invoice.
  - Separately: **Print placards** and **Print invoice** buttons.
- When placards are switched off entirely (see below), the list still lists orders for the invoice.
- Printing records `Package.placardPrintedAt` on each pallet (and `FreightPaperwork.invoicePrintedAt` per order),
  audited. A pallet change clears its `placardPrintedAt` and puts the order back on the list.
- **Print pages** are HTML pages printed with `window.print()`, the same way reports are printed today
  (`(report)` layout). No PDF library is needed.

**Placard** (`/print/orders/[id]/placards`): landscape letter, one page per pallet. Order number in very large
type, customer name and company, ship-to city and state, "Pallet 2 of 3", the pallet's dimensions and weight, and
a QR of the order (the order page URL, rendered with the existing `qrSvg`).

**Invoice** (`/print/orders/[id]/invoice`, `invoice.print`, any order): portrait letter, laid out like today's
WooCommerce invoice. The store name, bill-to (name, company, address, email, phone), ship-to, order number, order
date and payment method title come from the stored order. The lines show name, SKU, weight, quantity and line
total. The totals show subtotal, shipping (amount and method), fee and discount lines, tax and total. Everything
is read from `Order.rawPayload` through a pure `toInvoice(order)` mapper with recorded-fixture tests. There is no
live Woo call. Orders whose PII was purged show the redacted placeholders.

### Require placards (amends `packing`)

`Settings.freightRequirePlacards` (default **off**). When it is on:

- The packing screen in a freight zone shows each pallet's placard state ("Waiting for placard print",
  "Printed: mark applied") and an **Applied** tick per pallet (`Package.placardAppliedAt`, `placardAppliedById`).
- `zones`' `palletsPacked` gate calls this module's hook, which requires `placardPrintedAt` and
  `placardAppliedAt` on every pallet. It fails with `errors.freight.placardsMissing`.

When it is off, placards are optional, the Applied tick is hidden, and the gate hook passes.

### Freight settings

Settings → **Freight** (`freight.manage`): carriers (list, edit, archive, template editor with preview), and three
switches on `Settings`:

| Setting | Default |
|---|---|
| `freightNoteMode`: `ASK` / `AUTO`, "Customer note at pickup" | `ASK` |
| `freightRequirePlacards`, "Require placards before packing is finished" | off |
| `freightPrintTogether`, "Print placards and invoice together" | on |

### Spend (amends `rate-lab` Real orders)

Picked-up bookings count in Real orders spend on their pickup date (`pickedUpAt`): cost under the carrier's name,
shipment count 1, and pallets in place of packages. They are excluded from the parcel comparisons (quoted vs paid,
cheapest-pick), since there is no quote in Woolrus.

### API (oRPC, `packages/contracts/src/freight.ts`)

`freightCarriers.{list,create,update,archive}`, `freight.board`, `freight.book`, `freight.markPickedUp`,
`freight.sendNoteEarly`, `freight.resetNoteDraft`, `freight.updateNoteDraft`, `freight.paperworkList`,
`freight.markPrinted`, `freight.markPlacardApplied`, `orders.invoice` (the print page's data). Freight settings go
through the existing `settings.update`.

### Schema additions (approved with this spec)

- `Role.SCHEDULER`. `enum FreightBookingStatus { NEEDS_QUOTE BOOKED PICKED_UP CANCELLED }`,
  `enum FreightNoteMode { ASK AUTO }`.
- `FreightCarrier`, `FreightBooking` (unique `orderId`), `FreightPaperwork` (unique `orderId`,
  `invoicePrintedAt`, `printedById`): new tables in `schema/freight.prisma`.
- `Package.placardPrintedAt`, `placardAppliedAt`, `placardAppliedById`.
- `Settings.freightNoteMode`, `freightRequirePlacards`, `freightPrintTogether`.
- A seeded DDS Freight carrier.

### Files expected to change

`packages/core/src/freight/{carriers,booking,note,board,paperwork,invoice,gates}.ts` (+ tests),
`packages/core/src/workflow/{machine,gates,service}.ts` (the `pickedUp` kind and the gate hook),
`packages/core/src/shipping/{woo-push,tracking-provider}.ts`, `packages/core/src/notes/push.ts` (the
`woo.pushNotes` job), `packages/core/src/packing/service.ts` (placard state, re-quote on pallet change),
`packages/core/src/rate-lab/real-orders.ts`, `packages/core/src/permissions.ts`,
`packages/core/src/settings/service.ts`, `apps/worker/src/` (the job), `packages/contracts/src/{freight,settings,
orders}.ts`, `apps/web/src/server/router.ts`, `apps/web/src/app/(app)/z/[zone]/{freight,paperwork}/**`,
`apps/web/src/app/(app)/settings/freight/**`, `apps/web/src/app/(report)/print/orders/[id]/{invoice,placards}/**`,
`apps/web/src/app/(app)/orders/**` (send note early, print invoice), `packages/db/prisma/schema/{freight,auth,
shipping,system}.prisma` + migrations, `packages/db/prisma/seed*.ts`, `packages/i18n/src/messages/{en,es}.json`,
`apps/web/e2e/freight.spec.ts`.

## Success criteria

1. **Role:** a Scheduler can read the board and book, and gets `FORBIDDEN` on pickup, carriers, settings and the
   paperwork list. QA can print paperwork and invoices but not book. Every new procedure has an allowed and a
   forbidden test.
2. **Carriers:** CRUD and archive are audited. An unknown placeholder is refused. `renderFreightNote` pure tests
   cover every placeholder, empty values, and the seeded DDS text rendering exactly.
3. **Board:** only READY freight-zone orders with an open booking appear, in the stated order. An order still in
   PACKING or QA doesn't appear. The badge counts match. A user without the zone gets `FORBIDDEN`.
4. **Booking:** booking needs carrier, cost and BOL. Edits are audited. A pallet change, a repack and a reopened
   packing each set `NEEDS_QUOTE` with `requoteNeeded` and keep the old values. A booked order can't change zone.
5. **Note draft:** rendered at booking, re-rendered on change, frozen once edited, with the warning and reset.
   With no template there is no draft. Send early posts once and isn't re-sent at pickup.
6. **Picked up:** the `freightBooked` gate fails while it is needs quote or re-quote. `ASK` sends the edited text,
   or nothing when skipped. `AUTO` sends the template. The order is COMPLETED, the booking `PICKED_UP`, and
   `woo.push` posts tracking (AST with a provider, otherwise the note), the customer note, then Completed. A
   replayed job posts nothing twice (fake store test).
7. **Paperwork:** the list shows orders with saved pallets until printed and brings one back after a pallet change.
   Together and separately modes show the right buttons. Printing marks the pallets and the order.
8. **Require placards:** with the setting on, finishing packing fails until every pallet is printed and applied.
   With it off, it passes and the tick is hidden.
9. **Invoice:** `toInvoice` fixture tests cover the sample order (shipping, a discount line, zero tax), a fee line,
   a multi-line order and a purged order. The page shows every field of the sample.
10. **Spend:** a picked-up booking appears in Real orders spend under its carrier on its pickup date and is left
    out of the quoted-vs-paid comparison.
11. **End to end:** one Playwright test: a freight order is packed onto two pallets. QA prints paperwork (placards
    and invoice pages render). The Scheduler books DDS with a BOL. A pallet change brings back Re-quote needed,
    and the Scheduler re-books. An Admin marks it picked up, edits and sends the note. The fake store shows
    Completed, the BOL and the note.

## Assumptions

1. Freight is domestic. A customs commercial invoice isn't needed.
2. One booking per order. All its pallets go with one carrier on one BOL.
3. The Woo order payload has every invoice field (it is stored at import). The store name comes from the existing
   ship-from / store settings.
4. The QR only needs to open the order in Woolrus when scanned with a phone or tablet camera. It encodes the order
   page URL.
5. Freight cost is recorded for reporting only and isn't pushed to Woo.

## Decisions (2026-11-24, grilling session)

1. **A Scheduler role** books freight. Admins can do everything it can.
2. **Woo is not touched until pickup.** An Admin marks the order picked up, and only then are Completed, the BOL
   and the note pushed.
3. **The board shows orders once packing is done.**
4. **Admin-managed carriers, each with a note template.** The DDS message is seeded.
5. **The customer note is approved by an Admin by default.** A Freight setting switches to auto-send. The review
   happens in the Picked up dialog, and it can also be sent early.
6. **A booking goes back to needs quote when pallets change**, with a board flag and a nav badge. Other
   notifications are future work.
7. **The invoice is generated in Woolrus**, like the WooCommerce PDF used today, and is printable for any order.
8. **Placards are optional** (setting, default off). When required, the packer can't finish packing without them.
9. **Admin and QA print** the paperwork, since only they have printers, and hand it to the packer. Together or
   separately is a setting.
10. **Freight cost counts in spend** under the carrier's name.

## Open questions

1. **Picked up without a BOL**: some carriers issue the PRO number only at pickup. Should the BOL become optional
   at booking and required at pickup? The spec requires it at booking.
2. **Invoice prices:** the sample shows line totals in the Price column. Confirm line total, not unit price.
