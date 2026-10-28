# Woolrus — System Requirements Specification

Oct 14, 2026 · @Isaac

> **Status in this repo:** reference document. Requirements were reverse-engineered from v1 (tag `v1-legacy`).
> Where this document disagrees with [`decisions.md`](decisions.md), **decisions.md wins**. Notable overrides:
> units are stored as ounces/inches (not configurable canonical units, FR-SET-06 is display-only), one store and
> one warehouse (no multi-store/multi-warehouse), WooCommerce via REST v3 only (no WPGraphQL), returns are in
> scope (modelled now, built in M5), and Better Auth replaces Auth.js. The roadmap that delivers this document is
> in [`../SPEC.md`](../SPEC.md).

## 1. Introduction

Woolrus is a warehouse fulfillment app for WooCommerce shops: staff pull paid orders in, then pick, pack, QA, buy carrier labels and ship from one screen. This SRS describes it as a greenfield build, written as if no code exists.

**Purpose.** Give a rebuild team one source for what the system must do, how well, and where the first version fell short.

**Scope.** In scope: order intake from WooCommerce, the five-stage fulfillment workflow, packaging, shipping labels through ShipStation, notes with media, quality issues, item voids, settings and user preferences. Out of scope: storefront, payments, inventory purchasing, returns processing (see section 7 for a recommendation).

**How this was derived.** Requirements were reverse-engineered from the current repository (75 commits, Next.js 16 + Prisma + Postgres), its 19 database migrations, server actions, UI routes and README. Each requirement is marked:

- **[Existing]** behaviour the current code implements, restated as a requirement.
- **[New]** something the current code lacks or only stubs; recommended for the rebuild.

**Definitions.**

| Term | Meaning |
| --- | --- |
| Order | A WooCommerce order imported into Woolrus |
| Line item | One product (or variation) line on an order, with a quantity |
| Package | One physical box being shipped, holding one or more line items |
| Box | A reusable box size configured by an admin (L × W × H, max weight) |
| Workflow status | The order's fulfillment stage: Pending, Picking, Packing, QA, Ready, Completed, plus On Hold and Cancelled |
| Void | Removal of a line item from fulfillment, logged for later resolution |
| Quality issue | A recorded defect (wrong item, damage, etc.) with severity and resolution |
| Rate / Label | A carrier quote and a purchased shipping label from ShipStation |

## 2. Product overview

The system is the warehouse's single workspace between a WooCommerce store and the carriers: orders flow in from the shop, move through five fulfillment stages, and flow back out as shipped orders with tracking.

**Problem.** WooCommerce has no warehouse floor tooling. Staff need to know what to pick, how to split an order into boxes, who checked it, what went wrong, and which label belongs to which box, without switching between the shop admin and the carrier portal.

**Users and roles.** The current code defines four roles but never enforces them (see section 7). The rebuild must enforce them.

| Role | Primary jobs |
| --- | --- |
| Admin | Configure boxes, carriers, services; manage users and roles; resolve voids and quality issues; force status changes |
| Picker | Claim pending orders, pick items, mark out-of-stock or substituted |
| Packer | Choose boxes, split items into packages, record weights |
| QA | Verify each item per package, review rates, buy labels, report quality issues |
| Shipper (new) | Print aggregated labels, hand off to carrier, mark orders shipped; today any user does this |

**Operating context.**

- Store: WooCommerce on WordPress, read via WPGraphQL + WooGraphQL, written via WooGraphQL mutations and the WooCommerce REST API.
- Carriers: ShipStation API v2 for shipments, rates, labels and voids.
- Files: S3-compatible object storage for note photos and voice memos.
- Identity: OAuth sign-in (Discord today).
- Devices: desktop browsers at packing stations and tablets or phones on the floor; English and Spanish UI.

**Order lifecycle at a glance.** Pending → Picking → Packing → QA → Ready → Completed (shipped). Ready orders can be sent back to Packing ("repack"). On Hold and Cancelled exist as states but have no transitions in the current code. Section 3.2 defines the full state machine.

## 3. Functional requirements

Requirements are grouped by feature area. "Must" items define the minimum rebuild; [New] items close gaps found in the current code.

### 3.1 Order intake (WooCommerce sync)

| ID | Requirement | Origin |
| --- | --- | --- |
| FR-SYNC-01 | The system must import every WooCommerce order in `processing` status, paging through results (25 per page today). | Existing |
| FR-SYNC-02 | Import must be idempotent: an order already imported (matched on WooCommerce order ID) is skipped, never duplicated. | Existing |
| FR-SYNC-03 | Each order import must be atomic: products, variations, line items and the workflow record are written together or not at all. | Existing |
| FR-SYNC-04 | Import must capture order number, status, customer name and email, shipping and billing address, customer note, payment method, total and order date. | Existing |
| FR-SYNC-05 | Import must upsert the product and, for variable products, the variation (name, SKU, image, attributes) referenced by each line item. | Existing |
| FR-SYNC-06 | Every sync run must write a sync log row: type, status, records processed, error text, start and end time. | Existing |
| FR-SYNC-07 | The UI must show the time of the last sync in the navigation. | Existing |
| FR-SYNC-08 | Sync must be triggerable by CLI and by an authenticated HTTP endpoint (bearer secret) for cron use. | Existing (endpoint currently broken, see 7) |
| FR-SYNC-09 | Sync must run on a schedule (configurable, default every 5 min) and on demand from the UI by an Admin. | New |
| FR-SYNC-10 | Sync must detect changes to already-imported orders: cancellation, refund, address edits, line-item edits. A changed order in progress must be flagged, not silently overwritten. | New |
| FR-SYNC-11 | The system should accept WooCommerce order webhooks (`order.created`, `order.updated`) to cut sync latency, with polling as a fallback. | New |
| FR-SYNC-12 | Import must capture product weight, stock quantity and bin location (fields exist in the schema but are never filled today). | New |

### 3.2 Fulfillment workflow

*(The original document embedded a diagram here: order workflow, six stages, repack loop, hold and cancel.)*

Each stage exits only through its gate; Ready can loop back to Packing, and On Hold and Cancelled are new states the rebuild must wire up.

| ID | Requirement | Origin |
| --- | --- | --- |
| FR-WF-01 | Every order must have exactly one workflow status: Pending, Picking, Packing, QA, Ready, Completed, On Hold, Cancelled. | Existing |
| FR-WF-02 | Allowed transitions: Pending → Picking ("Begin Picking"); Picking → Packing (all active items picked); Packing → QA (all items boxed and weighed); QA → Ready (all items verified, a rate chosen per package, labels bought); Ready → Completed (ship); Ready → Packing (repack). | Existing |
| FR-WF-03 | The server must enforce the transition rules and completion gates; today they are enforced only by hiding buttons in the UI. | New |
| FR-WF-04 | The system must record who did each stage and when: picker (per item), packer, QA user, and start/complete timestamps for pick, pack, QA and completion. | Existing |
| FR-WF-05 | A workflow history panel must show each stage's people and timestamps. | Existing |
| FR-WF-06 | Any stage must be able to move an order to On Hold with a reason, and back to its previous stage. Admins can cancel. | New |
| FR-WF-07 | Claiming an order must lock it to one user; a second user opening it sees who holds it and can take over only with a confirmation. | New |
| FR-WF-08 | Every status change must be written to an append-only audit log (who, from, to, when, reason). | New |

### 3.3 Queues and order lists

| ID | Requirement | Origin |
| --- | --- | --- |
| FR-LIST-01 | One queue per stage (Pending, Picking, Packing, QA, Ready) showing order number, customer, item count, priority and order date, oldest first. | Existing |
| FR-LIST-02 | An All Orders view must list every order across statuses with search, column sorting and pagination. | Existing |
| FR-LIST-03 | Each queue must offer search by order number and customer. | Existing (UI only) |
| FR-LIST-04 | Priority must be computed from rules (shipping method, order age, customer tag), not hard-coded; today every order shows "High". | New |
| FR-LIST-05 | Queues must show stage age (time in current stage) and highlight orders past an SLA threshold. | New |
| FR-LIST-06 | Queues should refresh live (polling or push) so two stations don't work from stale lists. | New |

### 3.4 Picking

| ID | Requirement | Origin |
| --- | --- | --- |
| FR-PICK-01 | The picker sees each line item as a large touch card: image, name, SKU, variation attributes, quantity. | Existing |
| FR-PICK-02 | Tapping a card toggles it picked; the system records picker and time per item. | Existing |
| FR-PICK-03 | When every non-voided item is picked, the picker can complete and either open the order in Packing or return to the Pending queue for the next order. | Existing |
| FR-PICK-04 | The picker must be able to mark an item Out of Stock or Substituted (statuses exist in the schema, no UI today), with a note. | New |
| FR-PICK-05 | Items should be sorted by bin location, and a batch pick list across several orders should be available. | New |
| FR-PICK-06 | Barcode or SKU scanning should confirm the right item is picked. | New |

### 3.5 Packing

| ID | Requirement | Origin |
| --- | --- | --- |
| FR-PACK-01 | The packer adds one or more packages to an order, each using an active box size. | Existing |
| FR-PACK-02 | The packer assigns items to packages one unit at a time; quantities split across packages and merge back automatically. | Existing |
| FR-PACK-03 | The packer can remove an item from a package or delete a package; its items return to Unassigned. | Existing |
| FR-PACK-04 | The packer enters a weight (lb) per package; the box's max weight is shown as guidance. | Existing |
| FR-PACK-05 | A two-step wizard (Verify items → Pack) guides the packer. | Existing |
| FR-PACK-06 | Warnings show the count of unassigned items and packages missing a weight; Complete Packing appears only when both are zero. | Existing |
| FR-PACK-07 | Completing packing must start a background rate fetch for every package. | Existing |
| FR-PACK-08 | A drawer shows order basics, shipping address, pick history and all notes. | Existing |
| FR-PACK-09 | The system must reject a package weight above the box's max weight, or require an override reason. | New |
| FR-PACK-10 | The system should suggest a box from item dimensions and weights, and should read weight from a USB/Bluetooth scale. | New |

### 3.6 Quality assurance

| ID | Requirement | Origin |
| --- | --- | --- |
| FR-QA-01 | QA verifies each item in each package; a package is verified when all its active items are. | Existing |
| FR-QA-02 | QA sees the rates fetched per package, cheapest pre-selected, and can choose another or refresh rates. | Existing |
| FR-QA-03 | Complete QA must buy one label per package from the selected rate and must fail without changing status if any purchase fails. | Existing |
| FR-QA-04 | The QA drawer shows picker, packer, selected rates, and order, item and package notes. | Existing |
| FR-QA-05 | An item with an unresolved Critical quality issue must be flagged in QA. | Existing |
| FR-QA-06 | Complete QA must be blocked while any Critical issue on the order is open (today only flagged). | New |
| FR-QA-07 | Label purchase must be all-or-nothing per order: if package 2 of 3 fails, labels already bought for that order are voided or kept and retried, never left half-done silently. | New |

### 3.7 Shipping and labels

| ID | Requirement | Origin |
| --- | --- | --- |
| FR-SHIP-01 | For each package the system creates a ShipStation shipment linked to a sales order (order number, items, ship-from, ship-to). | Existing |
| FR-SHIP-02 | Rates are requested only for enabled carriers and filtered to enabled services. | Existing |
| FR-SHIP-03 | Ship-to falls back from shipping to billing address: the location (street, line 2, city, state, postal code, country) only as a whole, when shipping has none of it; name, company, phone and email field by field (changed from v1's field-by-field location, decisions 2026-10-27). | Existing |
| FR-SHIP-04 | Labels are bought as 4×6 PDF; tracking number, cost, carrier, service and download links are stored per package. | Existing |
| FR-SHIP-05 | In Ready, the user selects orders and clicks Ship: orders become Completed, and one merged PDF of all their labels opens for printing. | Existing |
| FR-SHIP-06 | Shipping pushes status Completed, tracking number and provider to WooCommerce, then posts all internal notes as private order notes. | Existing |
| FR-SHIP-07 | A failed WooCommerce push must be recorded on the order and reported per order, without undoing the local Completed status. | Existing |
| FR-SHIP-08 | Repack: selected Ready orders have active labels voided, rates, labels and packages cleared, and return to Packing, after a confirmation. | Existing |
| FR-SHIP-09 | Ship-from address must be configurable in Settings and support several warehouses; today it is environment variables. | New |
| FR-SHIP-10 | Failed WooCommerce pushes must be retried automatically and listed in an Admin "sync errors" view. | New |
| FR-SHIP-11 | Printing labels must be separate from marking shipped, so a reprint never re-ships and a misprint can be reprinted. | New |
| FR-SHIP-12 | Address validation should run before rate fetch, showing the corrected address to QA. | New |
| FR-SHIP-13 | Customs data (HS code, value, origin) must be supported for international services. | New |
| FR-SHIP-14 | An end-of-day manifest / SCAN form per carrier should be generated. | New |

### 3.8 Notes and attachments

| ID | Requirement | Origin |
| --- | --- | --- |
| FR-NOTE-01 | Users can add a note to an order, a line item, a package or a quality issue. | Existing |
| FR-NOTE-02 | A note can carry text, photos (camera or file) and one recorded voice memo. | Existing |
| FR-NOTE-03 | Attachments are stored in object storage and served by signed URLs that expire after 1 hour. | Existing |
| FR-NOTE-04 | Photos open in a lightbox; voice memos play inline. | Existing |
| FR-NOTE-05 | Cards show an indicator when notes exist. | Existing |
| FR-NOTE-06 | Notes can be edited and deleted; deleting removes its stored files. | Existing (no UI for edit, no author check) |
| FR-NOTE-07 | Only the author or an Admin may edit or delete a note. | New |
| FR-NOTE-08 | Each note must be marked internal or customer-visible; only customer-visible notes go to the customer in WooCommerce. | New |
| FR-NOTE-09 | Uploads must be limited by type (image/*, audio/*) and size (e.g. 15 MB), and images resized server-side. | New |

### 3.9 Quality issues

| ID | Requirement | Origin |
| --- | --- | --- |
| FR-QI-01 | Users can report an issue on an order, item or package: type (wrong item, damaged item, missing item, wrong quantity, packaging damage, labeling error, wrong box size), severity (minor, major, critical), description, evidence photos and voice. | Existing |
| FR-QI-02 | Each issue records the stage where it was discovered and, optionally, the stage where it originated. | Existing |
| FR-QI-03 | The responsible user is inferred from the originating stage (picker of the item, packer, or QA user) and can be changed. | Existing |
| FR-QI-04 | Issues can be reported as customer-reported from a Ready or Completed order. | Existing |
| FR-QI-05 | Issues can be resolved with notes; lists filter All / Open / Resolved. | Existing |
| FR-QI-06 | An issue can be linked to a label and marked as having triggered a repack. | Existing (data only) |
| FR-QI-07 | A cross-order quality dashboard must show issue counts by type, stage and responsible user over time. | New |
| FR-QI-08 | Deleting an issue must be Admin-only; others may only resolve. | New |

### 3.10 Item voids

| ID | Requirement | Origin |
| --- | --- | --- |
| FR-VOID-01 | Any stage can void a line item with a reason; the item leaves its package and is skipped by every completion gate. | Existing |
| FR-VOID-02 | Each void creates a void record noting the stage it happened in. | Existing |
| FR-VOID-03 | An unresolved void can be undone (unvoid). | Existing |
| FR-VOID-04 | A Voids page lists orders with unresolved voids; an Admin resolves each with a note on how it was handled in WooCommerce. | Existing |
| FR-VOID-05 | If every item on an order is voided, the order cannot proceed and a banner says so. | Existing |
| FR-VOID-06 | Voiding must support partial quantity (void 1 of 3). | New |
| FR-VOID-07 | Resolving a void should optionally refund or edit the line in WooCommerce through the API, instead of manual work in WooCommerce. | New |

### 3.11 Settings and administration

| ID | Requirement | Origin |
| --- | --- | --- |
| FR-SET-01 | Boxes: create, edit, archive, restore and delete box sizes (name, L×W×H in inches, optional max weight in lb), with validation. A box used by any package can only be archived. | Existing |
| FR-SET-02 | Shipping: sync carriers and services from ShipStation; enable or disable each carrier and service; show domestic/international flags. | Existing |
| FR-SET-03 | User: choose language (English, Spanish) and theme; collapse the sidebar; log out. Preferences persist per user. | Existing |
| FR-SET-04 | Users and roles: an Admin invites users, assigns roles, and deactivates users. | New |
| FR-SET-05 | Store connection, ShipStation key and ship-from addresses are managed in the UI with secrets stored encrypted. | New |
| FR-SET-06 | Units must be configurable (lb/kg, in/cm) and stored in one canonical unit. | New |

### 3.12 Reporting

| ID | Requirement | Origin |
| --- | --- | --- |
| FR-REP-01 | Throughput: orders and units per stage per user per day. | New |
| FR-REP-02 | Cycle time: median and p90 time from import to shipped, and per stage. | New |
| FR-REP-03 | Shipping spend by carrier and service, and label cost vs. shipping charged to the customer. | New |
| FR-REP-04 | Export any list or report to CSV. | New |

## 4. Data model

The domain needs 16 core entities plus auth tables; the rebuild should keep the current shape but separate "what was ordered" from "how it was packed", which the current model merges.

> The implemented model is in `packages/db/prisma/schema/`; see `decisions.md` § Data model for how it differs from this table.

| Entity | Key fields | Notes for the rebuild |
| --- | --- | --- |
| User | name, email, image, role(s), preferences (theme, locale, sidebar), active | Add role and active flag; the `UserRole` enum exists but is never attached to users |
| Order | WooCommerce ID (unique), order number, Woo status, customer name/email, shipping and billing address, customer note, payment method, total, order date, synced at, workflow status | Add currency, shipping method charged, priority, hold reason, Woo modified-at for change detection |
| OrderWorkflow | status, assignee, packer, QA user, start/complete times per stage, completed at, Woo pushed at, Woo push error, tracking number(s) | Replace with a stage-event table (FR-WF-08); store tracking per label, not a comma-joined string |
| OrderItem (line) | Woo product/variation ID, name, SKU, ordered quantity, price, image, attributes, pick status, picked by/at, voided flag/by/at/reason | Keep immutable as ordered; move package placement to PackageItem |
| PackageItem (new) | package, order item, quantity, packed flag, QA-verified flag | Today an OrderItem row is split and merged as units move between boxes, which rewrites order lines and duplicates notes' anchors |
| Product / ProductVariation | Woo ID, name, SKU, image, price, weight, stock, type, attributes, bin location | Fill weight, dimensions and bin location on sync |
| Box | name, L×W×H, max weight, active | Add tare weight and inner vs outer dimensions |
| Package | order, box, weight, ShipStation shipment ID | Add dimensions override for non-standard boxes |
| ShippingCarrier / CarrierService | ShipStation carrier ID, code, names, primary, enabled; service code, domestic/international, enabled | As is |
| ShippingRate | package, ShipStation rate ID, carrier, service, amount, currency, delivery days/date, guaranteed, trackable, selected | Add fetched-at and expiry; rates go stale |
| ShippingLabel | package (unique), ShipStation label/shipment ID, tracking, carrier, service, cost, format, PDF/PNG URLs, status (active/voided), ship date | Keep voided labels for history; repack deletes them today |
| Note | author, target (order / item / package / quality issue), content | Add visibility (internal / customer) |
| NoteAttachment | note, storage key, media type (image / voice), file name, size | Add content type, duration, thumbnail key |
| QualityIssue | order, item?, package?, type, severity, description, stage discovered/originated, customer reported, reporter, responsible, resolution notes, resolved by/at, triggered repack, linked label | As is; add status enum instead of inferring from resolved-at |
| OrderVoid | order, item, reason, stage voided, resolved flag/by/at, resolution notes | Add quantity voided |
| SyncLog | type, status, records processed, error, start/end | Add per-order error detail |
| AuditEvent (new) | actor, entity, entity ID, action, before/after, at | Backs FR-WF-08 and admin forensics |

Identifiers are UUIDs. All money stores amount and currency. All weights and dimensions store one canonical unit (FR-SET-06).

## 5. External interfaces

The system talks to four outside services; each must sit behind an adapter so it can be swapped (another store, another label broker) without touching workflow code.

| System | Direction | Operations | Auth | Notes |
| --- | --- | --- | --- | --- |
| WooCommerce via WPGraphQL + WooGraphQL (Pro) | In and out | Query processing orders with line items, products, variations; mutation to set order status Completed with tracking meta (`_tracking_number`, `_tracking_provider`) | Basic auth with a Shop Manager user's application password | Requires three WordPress plugins; Pro is paid. Consider REST-only to drop the plugin dependency |
| WooCommerce REST API v3 | Out | Add private order notes | Same credentials | Also the natural place for webhooks (FR-SYNC-11) and refunds (FR-VOID-07) |
| ShipStation API v2 | Out | List carriers and services; create shipment with sales order; get rates; buy label from rate; void label | API key header | One retry on HTTP 429 today; needs backoff and idempotency keys for label purchase |
| S3-compatible storage (RustFS locally) | Out | Put, get (signed URL, 1 h), delete note attachments | Access key/secret | Bucket created by a setup script |
| OAuth identity provider (Discord) | In | Sign in | OAuth 2 | Add Google/Microsoft or email magic link; restrict to invited users |

**Internal HTTP endpoints.**

| Endpoint | Purpose | Auth today | Required |
| --- | --- | --- | --- |
| `POST /api/sync/pull` | Trigger order import | Bearer `SYNC_SECRET` | Keep; fix broken import path |
| `GET /api/shipping/labels?orders=…` | Merge active label PDFs for orders into one PDF | None | Session + Shipper role |
| `/api/auth/*` | Sign-in callbacks | n/a | Keep |

**Hardware (new).** Barcode scanners as keyboard input; USB/Bluetooth scales via WebHID or a small local bridge; 4×6 thermal label printers via the browser print dialog or a print agent.

## 6. Non-functional requirements

The biggest non-functional gap is security: almost every server action runs without checking who is calling, so the rebuild must make authorization a framework default, not a per-function habit.

### Security

- NFR-SEC-01 Every server action and API route must require an authenticated session and check the caller's role; deny by default. [New]
- NFR-SEC-02 Sign-in must be limited to invited or allow-listed users; today any Discord account can sign in and gets full access. [New]
- NFR-SEC-03 Secrets (store credentials, ShipStation key, sync secret) live in a secrets manager or encrypted settings, never in client bundles. Rename `NEXT_PUBLIC_WOO_GRAPHQL_URL`, which ships the store URL to the browser. [New]
- NFR-SEC-04 All inputs are validated server-side with a schema (e.g. Zod). [New]
- NFR-SEC-05 Attachment URLs are signed and short-lived (1 h today). [Existing]
- NFR-SEC-06 Customer PII (names, addresses, emails) is retained only as long as needed; define a purge policy for completed orders. [New]

### Reliability and data integrity

- NFR-REL-01 Multi-step writes are transactional (order import, package moves, repack, void). [Existing]
- NFR-REL-02 External calls that cost money (label purchase) must be idempotent and recoverable: record intent before calling, reconcile after. [New]
- NFR-REL-03 Background jobs (rate fetch, Woo push, sync) run on a durable queue with retries and a dead-letter view; today rate fetch is fire-and-forget after the response. [New]
- NFR-REL-04 Concurrent edits to one order must not corrupt quantities; use optimistic locking (version column). [New]

### Performance

- NFR-PERF-01 Queue pages load in under 1 s at p95 with 2,000 open orders. [New]
- NFR-PERF-02 Item toggles (pick, verify) feel instant: optimistic UI with server confirm under 300 ms p95. [Existing pattern]
- NFR-PERF-03 Order detail must not sign every attachment URL on each load; sign lazily on view. [New]
- NFR-PERF-04 Queue search and pagination run on the server, not over the full list in the browser. [New]

### Usability and accessibility

- NFR-UX-01 Floor screens use large touch targets (current buttons are 160 px tall) and work on tablets. [Existing]
- NFR-UX-02 UI fully translated in English and Spanish; every string goes through the message catalog. [Existing]
- NFR-UX-03 User-selectable themes (35 today) with a readable default. [Existing]
- NFR-UX-04 Replace browser `alert()` dialogs with in-app toasts and per-order result panels. [New]
- NFR-UX-05 Meet WCAG 2.2 AA: keyboard navigation, focus states, labels on icon buttons. [New]

### Observability and operations

- NFR-OPS-01 Structured logs with request and order IDs; remove debug `console.log`. [New]
- NFR-OPS-02 Error tracking (e.g. Sentry) and health checks for DB, storage, WooCommerce and ShipStation. [New]
- NFR-OPS-03 Ship as a container image with migrations run on deploy; README says "Docker image coming". [New]
- NFR-OPS-04 Local stack via Docker Compose: Postgres, S3, WordPress + WooCommerce with seeded orders. [Existing]

### Maintainability

- NFR-DEV-01 Automated tests: unit tests for split/merge and gate logic, integration tests against a WooCommerce and ShipStation sandbox, end-to-end tests of one order from import to ship. The current repo has none. [New]
- NFR-DEV-02 CI runs lint, type-check, tests and migrations on every PR. [New]
- NFR-DEV-03 Typed integration clients (generate GraphQL types; today responses are `any`). [New]

## 7. Gaps and recommendations

The current code gets the floor workflow right but trusts the browser for every rule, has no roles, and has several money- and data-affecting defects; fix those before adding features.

### 7.1 Defects found in the current code

| # | Severity | Finding | Where | Rebuild requirement |
| --- | --- | --- | --- | --- |
| 1 | Critical | Server actions (create/delete package, set weight, verify item, select rate, ship, repack, void label, delete issue, toggle carriers, edit boxes) don't check the session; only the layout hides the UI from signed-out users. Anyone who can reach the server can call them. | `actions/**` (no middleware) | NFR-SEC-01 |
| 2 | Critical | Label merge endpoint has no auth: anyone with order IDs can download labels with customer names and addresses. | `app/api/shipping/labels/route.ts` | NFR-SEC-01 |
| 3 | High | Any Discord account can sign in and gets full access; the `UserRole` enum is defined but no user has a role. | `auth.ts`, `prisma/models/userRole.prisma` | NFR-SEC-02, FR-SET-04 |
| 4 | High | The cron sync endpoint imports `@/actions/pullOrders`, which doesn't exist (the file is `actions/sync/pullOrders.ts`), so scheduled sync can't work; only the CLI script syncs. | `app/api/sync/pull/route.ts` | FR-SYNC-08 |
| 5 | High | Label purchase loops over packages; if package 2 fails, package 1's label is already paid for and the order stays in QA. A retry skips paid labels, which is good, but nothing surfaces the partial state. | `actions/shipping/purchaseLabels.ts` | FR-QA-07, NFR-REL-02 |
| 6 | High | Repack ignores ShipStation's void result (`approved: false`) and then deletes the label rows, losing the record of a label that may still be billed. | `actions/orders/repackOrder.ts` | FR-SHIP-08, data model note on labels |
| 7 | High | Ship doesn't check the order is Ready or has active labels; it marks any selected order Completed. | `actions/shipping/shipOrders.ts` | FR-WF-03 |
| 8 | High | Every internal note (with author name) is posted to WooCommerce on ship. Re-running ship after a failed push posts them again. | `actions/shipping/shipOrders.ts` | FR-NOTE-08, FR-SHIP-10 |
| 9 | Medium | Orders are never updated after import, so a cancellation or address change in WooCommerce is invisible to the floor. | `actions/sync/pullOrders.ts` | FR-SYNC-10 |
| 10 | Medium | Packages without a weight are silently skipped during rate fetch; rates are deleted and refetched without expiry tracking. | `actions/shipping/fetchRates.ts` | FR-PACK-09, data model note on rates |
| 11 | Medium | Splitting an item across boxes creates new OrderItem rows and merging deletes them, so notes, voids and quality issues attached to a deleted row are lost (cascade). | `assignItemToPackage.ts`, `removeItemFromPackage.ts` | PackageItem entity in section 4 |
| 12 | Medium | Tracking provider is always sent as "ShipStation" and multiple tracking numbers are joined with commas into one field. | `shipOrders.ts`, `purchaseLabels.ts` | Store tracking per label; send the real carrier |
| 13 | Low | Priority column is hard-coded to "High" on every queue. | `app/orders/_components/*/Table.tsx` | FR-LIST-04 |
| 14 | Low | The "Complete Picking → Go To Pending" button moves the order to Packing and returns to the Pending list; the label reads as if the order goes back to Pending. | `picking/CompletionButtons.tsx` | Relabel: "Done, next order" |
| 15 | Low | QA button text, rate errors and the void-label error are hard-coded English, bypassing the Spanish catalog. | `qa/CompleteQAButton.tsx` and others | NFR-UX-02 |
| 16 | Low | Out of Stock and Substituted pick statuses, product weight, stock and bin location, On Hold and Cancelled states exist in the schema with no way to set them. | `prisma/models/*` | FR-PICK-04, FR-SYNC-12, FR-WF-06 |
| 17 | Low | Home page is empty; signed-in users land on a blank screen. | `app/page.tsx` | Dashboard with queue counts and SLA alerts |
| 18 | Low | No tests, no CI, debug logging left in the ShipStation client. | repo | NFR-DEV-01/02, NFR-OPS-01 |

### 7.2 Features worth adding

Ranked by value to a small warehouse, highest first.

1. **Roles, invites and a server-enforced state machine.** Turns the app from a trusted-LAN tool into something safe to put on the internet.
2. **Change detection and webhooks from WooCommerce.** Prevents shipping cancelled or edited orders.
3. **Barcode scanning for pick and QA.** Catches wrong-item errors at the source, which is the most common issue type the app tracks.
4. **Scale integration and box suggestion.** Removes manual weight entry, the step most likely to cause bad rates.
5. **On Hold flow and order claiming.** Lets staff park problem orders and stops two people working the same order.
6. **Separate print and ship, with reprint.** Makes label printing safe to repeat.
7. **Shipping rules.** Auto-select service by customer-paid shipping method, destination and weight instead of always cheapest; respect delivery promises.
8. **Batch and wave picking.** Pick several orders in one walk, sorted by bin.
9. **Returns (RMA).** Customer-reported issues today end at a note; add return labels and restock.
10. **Reporting and a home dashboard.** Throughput, cycle time, error rates by stage and person, shipping spend.
11. **Customer notifications.** Shipped email with tracking from WooCommerce, or directly.
12. **Packing slips and pick lists as PDFs**, printed with the label.
13. **Multi-warehouse and multi-store support.** Ship-from per location; more than one WooCommerce shop.
14. **Offline tolerance on the floor.** Queue item toggles locally when Wi-Fi drops and replay them.

### 7.3 Architecture recommendations

- Put all business rules in a domain service layer (state machine, gates, split/merge) that every entry point calls; UI and API stay thin.
- Run integrations through a job queue (e.g. pg-boss or BullMQ) with retries, idempotency keys and a failed-jobs view.
- Keep the store and label provider behind interfaces so Shopify or EasyPost can be added later.
- Use generated, typed clients for WooCommerce GraphQL and ShipStation.

## Appendix A. Current feature inventory

The current codebase implements 30 user-facing features; each maps to the requirements above.

| Feature | Screen / entry point | Requirements |
| --- | --- | --- |
| Discord sign-in, login screen | `/` (signed out) | 5, NFR-SEC-02 |
| Sidebar with stage queues, Voids, All Orders, Settings, last sync time, collapse | All pages | FR-LIST-01, FR-SYNC-07 |
| Order import from WooCommerce (CLI) | `pnpm sync:pull` | FR-SYNC-01–06 |
| Order import via cron endpoint (broken) | `POST /api/sync/pull` | FR-SYNC-08 |
| Dev data reset keeping boxes | `pnpm sync:reset` | NFR-OPS-04 |
| Stage queues with search box | `/orders?status=…` | FR-LIST-01, 03 |
| All Orders table with search, sort, paging | `/view` | FR-LIST-02 |
| Pending order detail, Begin Picking | Order page, Pending | FR-WF-02, 04 |
| Pick item toggle with picker and time | Order page, Picking | FR-PICK-01–03 |
| Packing wizard: verify then pack | Order page, Packing | FR-PACK-05 |
| Add/remove packages by box size | Packing | FR-PACK-01, 03 |
| Unit-level split and merge of items across packages | Packing | FR-PACK-02 |
| Package weight entry, max weight shown | Packing | FR-PACK-04 |
| Unassigned item and missing weight warnings | Packing | FR-PACK-06 |
| Order details drawer with workflow history | Packing, QA | FR-PACK-08, FR-QA-04, FR-WF-05 |
| Background rate fetch on pack complete | Server | FR-PACK-07, FR-SHIP-01–03 |
| Per-item QA verification by package | Order page, QA | FR-QA-01 |
| Rate selection and refresh | QA | FR-QA-02 |
| Label purchase on QA complete | QA | FR-QA-03, FR-SHIP-04 |
| Ready queue: multi-select, Ship, merged label PDF | `/orders?status=READY` | FR-SHIP-05 |
| Push Completed, tracking and notes to WooCommerce | Server | FR-SHIP-06, 07 |
| Repack with label void | Ready queue | FR-SHIP-08 |
| Notes with photos and voice on order, item, package, issue | All order stages | FR-NOTE-01–06 |
| Quality issue report, resolve, filter, delete | All order stages | FR-QI-01–06 |
| Customer-reported issues | Ready order page | FR-QI-04 |
| Item void and unvoid with reason | All order stages | FR-VOID-01–03, 05 |
| Voids page and void resolution | `/voids` | FR-VOID-04 |
| Box settings: add, edit, archive, restore, delete | `/settings` Boxes | FR-SET-01 |
| Carrier and service sync and toggles | `/settings` Shipping | FR-SET-02 |
| User settings: language, theme, log out | `/settings` User | FR-SET-03 |

**Current stack, for reference:** Next.js 16 (App Router, server actions), React 19, TypeScript, Prisma 7 on PostgreSQL 17, Auth.js v5, next-intl, Zustand, TanStack Table, Tailwind 4 + daisyUI 5, pdf-lib, AWS S3 SDK, graphql-request. A greenfield rebuild can keep this stack; the gaps in section 7 are design gaps, not stack limits.
