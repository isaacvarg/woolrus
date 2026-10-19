# Spec: `store-sync`

**Milestone:** M1 · **Depends on:** `settings` (WooCommerce config), `workflow` data model and transition service
· **Used by:** every floor module (orders and products to work on), `shipping` (reuses the WooCommerce adapter for
the Completed + tracking push), `exceptions` (refunds, FR-VOID-07), `operations` (adapter health check) ·
**State:** done

Project-wide commands, structure, code style, testing levels and boundaries are in [`../../SPEC.md`](../../SPEC.md);
this spec only adds what is specific to `store-sync`.

## Objective

Bring paid WooCommerce orders, and the products they reference, into Woolrus reliably and quickly, and keep them
honest afterwards: when the store cancels or edits an order, the floor finds out before it ships the wrong thing.

- **SRS:** FR-SYNC-01…12, NFR-REL-01/03, SRS §7.1 defects #4 (broken cron sync) and #9 (orders never updated).
- **Users:** nobody operates sync day to day; it runs on a schedule and on webhooks. Admins trigger it on demand,
  read the sync log, test the connection, and review external changes. Everyone sees when the last sync ran.
- **Why now:** it's the last M1 piece. With it, real orders replace the demo seed in the queues `workflow` built.

### User stories

1. As an admin, a new paid order in WooCommerce shows up in the Pending queue within a minute (webhook), or
   within the sync interval if webhooks are down (polling).
2. As an admin, I click **Sync now** and see the run finish in the sync log with how many orders it imported and
   which ones failed and why.
3. As a picker, I see a product's bin location, weight and image on the order because the product came with it.
4. As anyone, I see in the nav when the last sync ran, and it turns red when sync is failing or late.
5. As an admin, when the store cancels an order nobody has started, it simply leaves the queue. When the order was
   already being worked, it goes On Hold with "Cancelled in store" so nobody ships it, and I cancel it properly.
6. As an admin, when the customer's address changes in the store after picking started, the order is flagged. I
   see exactly what changed and choose **Apply** or **Dismiss**.
7. As an admin, I press **Test connection** in Settings → Integrations and learn whether the URL and keys work.

## Scope

**In:**
- A WooCommerce adapter in core (REST v3): interface, HTTP implementation, response schemas, an in-memory fake.
- Order import: new `processing` orders with their lines, products and variations, one transaction per order.
- Change detection on already-imported orders, with the auto-apply / auto-cancel / hold / flag rules below, and
  admin **Apply** / **Dismiss** for flagged changes.
- Product catalog sync (weight, dimensions, stock, bin location, virtual → `physical`), manual and nightly.
- Webhook receiver (`order.created`, `order.updated`): signature check, inbox, worker processing.
- Scheduling in the worker (honouring `Settings.syncIntervalMinutes`), one-at-a-time locking, `pnpm sync:pull`.
- Sync log (`SyncRun`, `SyncRunError`), an admin Sync page, the last-sync indicator in the nav, the Test
  connection button, the external-change banner on order detail.
- **Settings follow-up (decided 2026-10-15):** changing an integration URL's origin clears that integration's
  secrets (edits `SPEC-settings.md` and `docs/decisions.md` in this module's PR).

**Out (owned elsewhere):**
- Pushing Completed + tracking and order notes back to WooCommerce: `shipping` (it reuses this adapter and adds
  write methods to it).
- Creating refunds in WooCommerce, and voiding lines after a partial refund: `exceptions`.
- `/api/health` entry for WooCommerce: `operations` (calls this module's `ping`).
- Registering webhooks in the store automatically (the admin pastes the URL and secret; see Assumptions).
- Purging PII from `rawPayload`: `operations` (NFR-SEC-06).
- Several stores.

## Design

### Adapter (`packages/core/src/adapters/woocommerce/`)

```ts
// adapter.ts
export interface StoreAdapter {
  ping(): Promise<void>;                                      // throws StoreError
  getUnits(): Promise<{ weight: WeightUnit; dimension: DimensionUnit }>;
  listOrders(q: { status?: "processing"; modifiedAfter?: Date; include?: number[]; page: number }):
    Promise<{ orders: WooOrder[]; totalPages: number }>;
  getOrder(id: number): Promise<WooOrder | null>;            // null on 404
  getProducts(ids: number[]): Promise<WooProduct[]>;         // `include=`, batches of 100
  listProducts(page: number): Promise<{ products: WooProduct[]; totalPages: number }>;
  listVariations(productId: number): Promise<WooVariation[]>;
}
```

- `http.ts`: built on Node `fetch` (no new dependency). Basic auth with the consumer key/secret, `per_page=100`,
  dates as GMT (`dates_are_gmt=true`), 30 s timeout. Retries 429, 5xx and network failures (connection,
  timeout) up to 3 times with exponential backoff, honouring `Retry-After` (capped at 60 s). Test connection uses
  a 10 s timeout and no retries, since someone is waiting. Never follows redirects (a 3xx is `notWooCommerce`), so
  a store URL can't bounce requests to another host. Never logs credentials or customer data; logs method,
  path, status, duration.
- Failures are a typed `StoreError` with a kind: `unauthorized` (401/403), `notFound`, `unreachable` (DNS,
  connection, timeout), `notWooCommerce` (no `/wp-json/wc/v3` index), `rateLimited`, `badResponse` (schema
  mismatch). Each maps to an `errors.sync.*` message key.
- `schemas.ts`: Zod schemas for only the fields we read, `.passthrough()` so the raw object is stored whole.
- `fake.ts`: in-memory `FakeStoreAdapter` with helpers to add, edit, cancel and refund orders, used by every core
  test. Recorded JSON fixtures from the dev store (`__fixtures__/`) test the schemas and mapping.
- `createStoreAdapter(config)` builds the HTTP adapter from `getIntegrationConfig(db).woocommerce`; services take a
  `StoreAdapter` argument so tests inject the fake.

### Mapping (`packages/core/src/sync/mapping.ts`, pure)

| Woolrus | WooCommerce |
|---|---|
| `Order.wooOrderId`, `number`, `wooStatus`, `currency` | `id`, `number`, `status`, `currency` |
| `customerName`, `customerEmail` | shipping first + last name (billing name if shipping is empty), `billing.email` |
| `shippingAddress`, `billingAddress` | `shipping`, `billing` objects (normalised keys) |
| `customerNote`, `paymentMethod` | `customer_note`, `payment_method_title` |
| `totalCents`, `shippingChargedCents`, `shippingMethod` | `total`, Σ `shipping_lines[].total`, `shipping_lines[].method_title` joined |
| `orderedAt`, `wooModifiedAt` | `date_created_gmt`, `date_modified_gmt` |
| `OrderItem` per `line_items[]` | `id` → `wooLineItemId`, `product_id`, `variation_id`, `name`, `sku`, `quantity`, `price`, `image.src`, variation attributes from `meta_data` (display key/value), all `meta_data` |
| `OrderItem.bundleParentId` | WooCommerce Product Bundles `bundled_by` meta, if present (see Open questions) |
| `Product` / `ProductVariation` | `id`, `type`, `name`, `sku`, `images[0].src`, `price`, `weight`, `dimensions`, `stock_quantity`, `virtual` → `physical = !virtual`, bin location (see Open questions) |

- **Money** is parsed from decimal strings to integer cents without floating point (`"24.00"` → `2400`).
- **Units:** weight and dimensions are converted from the store's units (`getUnits()`, read once per run: `lbs`,
  `oz`, `kg`, `g`; `in`, `cm`, `mm`, `m`, `yd`) to ounces and inches with the existing `units.ts` helpers. Empty
  strings become null.
- The full order and product objects are stored in `rawPayload`.

### Import (`packages/core/src/sync/orders.ts`)

`syncOrders(db, store, { type: "ORDERS_POLL" | "ORDERS_WEBHOOK", orderIds?, now? })`:

1. Takes the sync lock (below); if it's held, returns `{ status: "alreadyRunning" }` without writing a run.
2. Writes a `SyncRun` (`RUNNING`).
3. Chooses what to fetch:
   - **First run** (no earlier `ORDERS_POLL` that finished `SUCCEEDED` or `PARTIAL`): every `processing` order.
   - **Later runs:** every order with `modified_after` = start of the last finished poll − 10 minutes (overlap
     for clock skew), any status, plus the external ids that failed in the previous run (`include=`).
   - **Webhook / single order:** `getOrder(id)` for each id; the webhook body is never trusted as data.
4. For each fetched order, in its own transaction, under `pg_advisory_xact_lock` on the WooCommerce id (so a
   webhook and a poll can't import the same order twice):
   - **Unknown order** with status `processing`: upsert the products and variations it references (fetched before
     the transaction, refreshed if `syncedAt` is older than 24 h), create the `Order` in `PENDING` with its
     `OrderItem`s, an `OrderStageEvent` (`null → PENDING`, reason `imported`), an audit event, then
     `recomputePriorities(tx, { orderIds: [id] })` and `notifyOrderChanged`. Unknown orders in any other status
     are skipped.
   - **Known order**, `date_modified_gmt` < `wooModifiedAt`, or equal with an identical payload: skipped
     (idempotent, FR-SYNC-02). Woo's modified time has one-second resolution, so an equal time with a different
     payload is an edit made in the same second as the version imported, and counts as newer **only if it was
     fetched after the stored copy** (`syncedAt` is the fetch time): two copies from that second can arrive out of
     order when a webhook job and a poll, or two webhook jobs, overlap.
   - Whether to create or update is decided again under the per-order lock, so a newer copy that loses the race
     to create the order is applied as a change instead of being dropped.
   - Products and variations are written in id order, so concurrent imports sharing products can't deadlock.
   - **Known order, newer:** change detection (next section).
   - A failure rolls back that order only, adds a `SyncRunError` (`externalId`, message key + detail), and the run
     continues.
5. Finishes the run: `SUCCEEDED`, `PARTIAL` (some orders failed) or `FAILED` (nothing could be fetched, e.g.
   auth), with `recordsProcessed`, `recordsFailed`, `finishedAt`, and `error` for a whole-run failure. A
   missing WooCommerce config fails the run with `errors.sync.notConfigured`.

Products referenced by a line but deleted in the store (`product_id: 0` or 404) leave `productId` null; the
workflow already treats such lines as physical.

### Change detection (`packages/core/src/sync/changes.ts`)

`diffOrder(stored, incoming)` (pure) compares the tracked fields and returns a `ChangeSummary`:
`{ status?: { from, to }, shippingAddress?, billingAddress?, customerNote?, shippingMethod?, customer?,
lines: { added[], removed[], quantity[{ wooLineItemId, from, to }] }, refunds?: { from, to } }` (refunded cents:
Woo's order payload carries refund totals, not refunded lines).
Untracked differences (meta noise) only update `rawPayload` and `wooModifiedAt`.

An order is **untouched** when it's `PENDING`, has no live claim, no line has `pickedQuantity > 0`, and it has no
packages, voids, quality issues or notes.

| Change in the store | Untouched order | Order in progress (any other non-terminal status) | `COMPLETED` / `CANCELLED` |
|---|---|---|---|
| Status → `cancelled`, `refunded` or `failed` | **Cancel** via `transition(kind: "cancel")`, reason `sync.reason.cancelledInStore` | **Hold** (reason "Cancelled in store") unless already On Hold, and **flag** | flag only |
| Address, note, customer, shipping method, line edits | **Apply** in place (lines added / removed / re-quantified), recompute priority | **Flag** | flag only |
| Partial refund (refunds present, status unchanged) | **Flag** (voiding is `exceptions`' job) | **Flag** | flag only |
| Any other status change (e.g. `completed`, `on-hold` in the store) | **Flag** | **Flag** | flag only |

- **The store catching up is not a change** (decided 2026-10-19): on a `COMPLETED` order, store status
  `completed`; on a `CANCELLED` order, store status `cancelled` / `refunded` / `failed` and any refund. These come
  from Woolrus itself (`shipping` pushes Completed, `exceptions` refunds) and only update `wooStatus` and the
  payload. Other changes on terminal orders are still flagged.

- `wooStatus`, `wooModifiedAt` and `rawPayload` always take the incoming values; they're informational.
- **Flag** = set `externalChangeDetectedAt` and `externalChangeSummary` = `{ diff, incoming, baseline }` (the
  mapped incoming order without its raw payload, and the stored `wooStatus` / refunded cents the diff started from,
  since those columns follow the store). A later change while flagged recomputes the diff against the stored order, so the summary is
  always "stored vs. latest store version", never a stack of partial diffs. Flagging bumps `version` (the floor's
  screen should refresh to show the banner) and notifies.
- Auto-apply, auto-cancel and auto-hold are written by the **system actor** (below), audited as
  `order.externalChange.applied` / the workflow's own events, and appear in the order history as "Store sync".

### Reviewing a flagged change (`packages/core/src/sync/review.ts`)

| Function | Permission | Effect |
|---|---|---|
| `applyExternalChange(db, actor, { orderId, expectedVersion })` | `order.resolveExternalChange` (new, Admin) | Applies the stored `incoming` to the order, clears the flag, audits before/after |
| `dismissExternalChange(db, actor, { orderId, expectedVersion, reason })` | same | Clears the flag without changing the order; reason required; audited. Remembers the dismissed store version (`externalChangeSummary = { dismissed }`, no `detectedAt`): later store edits flag again only if a tracked field differs from it, so plugin edits (export flags, invoice numbers) don't bring the flag back. When they do flag, the diff is still "stored vs. latest" |

Applying never corrupts work already done. Header fields (addresses, note, customer, shipping method) always apply.
A line change applies only if the line can absorb it, otherwise Apply fails with `CONFLICT` /
`errors.sync.cannotApply` and an unmet list, like a workflow gate:
- **added line** and **quantity up:** while the order is Pending, Picking or Packing (or On Hold from one of
  them): the Picking and Packing gates then ask for the extra units. Past Packing (QA, Ready, Completed,
  Cancelled, or On Hold from those) they're refused (`errors.sync.unmet.pastPacking`): the QA and Ready gates check
  packages and labels, not line quantities, so the order would ship short. The admin forces it back to Packing
  first, or dismisses;
- **quantity down:** only to ≥ max(`pickedQuantity`, Σ packed quantity), and only if the line has no voids;
- **removed line:** only if nothing is picked or packed and nothing (notes, issues, voids) hangs off it.

Status changes are never applied by Apply: the admin uses the workflow's cancel / resume / force actions, and the
banner says so. When Apply is refused, the admin voids or unpacks first, or dismisses.

### System actor (`packages/core/src/permissions.ts`)

`Actor.userId` becomes `string | null`, and a `systemActor` constant (`userId: null`, roles `[ADMIN]`,
`stationId: null`, `system: "store-sync"`) is exported for jobs. Audit rows and stage events get `actorId` null;
history shows "Store sync". Claims compare user ids, so the system actor never holds or takes a claim. API
middleware can never produce a system actor.

### Products (`packages/core/src/sync/products.ts`)

- `syncProducts(db, store)` (`SyncRun` type `PRODUCTS`): pages every product, fetches variations of variable
  products, upserts on `wooProductId` / `wooVariationId`. Never deletes rows; a product missing from the store
  just stops being refreshed.
- Runs nightly (03:00 server time) and from **Sync products** on the Sync page. Order import also upserts the
  products it needs (FR-SYNC-05), so the catalog sync is for freshness (stock, bins, weights), not correctness.
- Warehouse-only fields (`hsCode`, `countryOfOrigin`, `customsDescription`, `lumexiaItemId`, `barcode` unless the
  store sends one) are never overwritten by sync.

### Webhooks (`apps/web/src/app/api/webhooks/woocommerce/route.ts` → `packages/core/src/sync/webhooks.ts`)

- A Next.js route handler (not oRPC: the signature is over the raw body). The route reads the raw body and
  headers and calls `receiveWooWebhook(db, { headers, rawBody })`, which:
  - answers `200` to WooCommerce's ping on webhook creation (form body `webhook_id=…`, no signature);
  - rejects with `401` when `wooWebhookSecret` isn't configured or `X-WC-Webhook-Signature` ≠ base64
    HMAC-SHA256(rawBody, secret) (constant-time compare); a missing or malformed signature is refused before
    settings are read;
  - ignores topics other than `order.created` / `order.updated` with `200`;
  - inserts an `InboundWebhook` (`source: "woocommerce"`, `deliveryId` = `X-WC-Webhook-Delivery-ID`, `topic`,
    `payload`) and enqueues `orders.webhook { inboundWebhookId }` in the same transaction; a duplicate delivery
    hits the unique key and returns `200` without enqueuing;
  - limits the body to 1 MB.
- The worker job runs `syncOrders(… { type: "ORDERS_WEBHOOK", orderIds: [payload.id] })` and sets
  `processedAt` or `error`. Polling stays on as the fallback (FR-SYNC-11).

### Jobs and scheduling (`packages/core/src/jobs.ts`, `apps/worker/src/`)

| Queue | Payload | Trigger |
|---|---|---|
| `orders.sync` (exists) | `{ reason: "schedule" \| "manual" }` | worker tick every minute; runs only when `syncIntervalMinutes` has passed since the last poll started, so changing the interval needs no rescheduling (FR-SYNC-09). Manual runs always go |
| `orders.webhook` (new) | `{ inboundWebhookId }` | webhook receiver; up to 4 at once, polled every 0.5 s (the per-order lock serialises the same order) |
| `products.sync` (new) | `{ reason: "schedule" \| "manual" }` | nightly, and the Sync page |

- **One at a time:** `withSyncLock(db, "orders" | "products", fn)` takes a Postgres advisory lock
  (`pg_try_advisory_xact_lock`, held by one open transaction for the run, up to 1 h: Prisma's pool can't release a
  session lock on the connection that took it), so the worker, the CLI and a manual run never overlap. Webhook jobs use the per-order
  lock only, so they're never blocked behind a long poll.
- **Enqueueing from web:** `@woolrus/core` gains `enqueue(tx, queue, payload)` using pg-boss's `send` with the
  caller's transaction as executor, so a job is only visible if the change that caused it commits. This adds
  `pg-boss` (already in the workspace at 12.38.0) as a dependency of `@woolrus/core`; **approving this spec
  approves that dependency.**
- **CLI:** `pnpm sync:pull` (and `pnpm sync:products`) in `apps/worker`, running the same core functions directly
  and printing the run summary (FR-SYNC-08).
- **No HTTP cron endpoint** (decided 2026-10-15): the `POST /api/sync/pull` + `SYNC_SECRET` of FR-SYNC-08 is
  replaced by the worker schedule, the admin button and the CLI. Recorded in `docs/decisions.md`.

### API (oRPC, `packages/contracts/src/sync.ts`)

| Procedure | Route | Permission | Returns |
|---|---|---|---|
| `sync.status` | `GET /sync/status` | `order.read` | last `ORDERS_POLL` start/finish/status, last success, last webhook received, interval, `stale`: `"failing"` (the last finished poll failed), `"late"` (no successful poll — `SUCCEEDED` or `PARTIAL` — for 3 × interval) or null |
| `sync.runs` | `GET /sync/runs` | `settings.manage` | runs, newest first, cursor-paged, with counts and the whole-run error as `errorKey` + `errorDetail`; filter by type |
| `sync.runErrors` | `GET /sync/runs/{id}/errors` | `settings.manage` | the run's `SyncRunError`s as message key + detail, with the order (`id`, `number`) when the WooCommerce id is an imported order |
| `sync.run` | `POST /sync/run` | `settings.manage` | enqueues a manual `orders.sync` or `products.sync` (`{ target }`), audited `sync.request`; returns `{ target, queued }`; idempotent on `idempotencyKey` |
| `sync.testConnection` | `POST /sync/test-connection` | `settings.manage` | `{ ok: true, units }` or `{ ok: false, messageKey }` |
| `orders.externalChange.apply` | `POST /orders/{id}/external-change/apply` | `order.resolveExternalChange` | order detail |
| `orders.externalChange.dismiss` | `POST /orders/{id}/external-change/dismiss` | `order.resolveExternalChange` | order detail |

`getOrder` (workflow detail) gains `externalChange: { detectedAt, diff } | null` for users with `order.read`;
`incoming` (raw store data) is never sent to clients.

### Settings follow-up (`packages/core/src/settings/service.ts`)

`updateSettings`: when `wooStoreUrl` or `lumexiaBaseUrl` changes **origin** (scheme + host + port), or is removed,
and that integration has secrets set, the same transaction clears them and writes `secret.clear` audit events with
`reason: "urlChanged"`. The response lists the cleared names (`clearedSecrets`); the Integrations card confirms
before saving ("Remove the saved keys?") and shows them as Not set afterwards. A path-only change keeps the secrets,
and so does setting a URL where there was none.

### UI

- **Nav (everyone):** "Synced 3 min ago" under the queue list, from `sync.status`, refreshed with the live-update
  stream and every minute; red with "Sync failing" / "Sync late" (or "Not synced yet") when `stale` (FR-SYNC-07).
- **Sync page** `/sync` (Admin): **Sync orders now** and **Sync products now**; a table of runs (type, status,
  processed, failed, started, duration) with expandable errors (WooCommerce id linked to the order when it
  exists); last webhook received.
- **Settings → Integrations → WooCommerce:** **Test connection** with the translated result; the webhook delivery
  URL (`https://<host>/api/webhooks/woocommerce`) with copy button and short setup steps (topics, API version v3,
  secret = the saved webhook secret).
- **Order detail:** an external-change banner (warning colour) listing what changed in plain words (old → new),
  with Apply / Dismiss for admins; an unmet list when Apply is refused. Queues already show the flag icon.
- All strings in `en` and `es`; tablet-sized targets on the banner.

### Files expected to change

`packages/core/src/adapters/woocommerce/**`, `packages/core/src/sync/**` (+ tests), `packages/core/src/jobs.ts`,
`packages/core/src/permissions.ts`, `packages/core/src/audit.ts` (null actor), `packages/core/src/workflow/{detail,
people}.ts`, `packages/core/src/settings/service.ts`, `packages/core/src/index.ts`, `packages/core/package.json`
(pg-boss), `packages/core/test/**` (fake adapter helpers), `packages/contracts/src/{sync,orders,index}.ts`,
`apps/web/src/server/router.ts`, `apps/web/src/app/api/webhooks/woocommerce/route.ts`,
`apps/web/src/app/(app)/{sync,settings,orders}/**`, `apps/web/src/app/(app)/layout.tsx`, `apps/worker/src/**`,
`apps/worker/package.json` (CLI scripts), root `package.json` (`sync:pull`), `turbo.json` (env if needed),
`packages/i18n/src/messages/{en,es}.json`, `apps/web/e2e/sync.spec.ts`, `docs/decisions.md`,
`docs/specs/SPEC-settings.md`. **No Prisma schema change is expected** (Order, OrderItem, Product, SyncRun,
SyncRunError and InboundWebhook already have every column). Needing one means asking first.

## Success criteria

1. **Import (FR-SYNC-01/03/04/05/12):** with the fake holding 230 `processing` orders over 3 pages, a first poll
   imports all of them with every mapped field, lines, products and variations (weights in oz, dimensions in in,
   money in cents, `physical` from `virtual`), each in `PENDING` with one `null → PENDING` stage event and computed
   priority. Orders in other statuses aren't imported.
2. **Idempotent (FR-SYNC-02):** running the poll twice, and a webhook plus a poll for the same order concurrently,
   leaves exactly one order and one set of lines.
3. **Atomic (FR-SYNC-03):** an order whose product fetch or write fails leaves no partial rows, gets a
   `SyncRunError`, the run ends `PARTIAL`, the other orders import, and the next run retries the failed id.
4. **Sync log (FR-SYNC-06):** every run writes one `SyncRun` with type, status, counts, timestamps and, on failure,
   a message key. Wrong credentials → `FAILED` with `errors.sync.unauthorized`; missing config →
   `errors.sync.notConfigured`.
5. **Change detection (FR-SYNC-10):** each row of the change table has a test: untouched + cancelled → `CANCELLED`
   with a system-actor stage event; in progress + cancelled → `ON_HOLD` and flagged; untouched + address edit →
   applied and audited; in progress + address edit → flagged with an exact diff and the order unchanged; partial
   refund → flagged; terminal orders → flagged only. A second edit while flagged replaces the diff.
6. **Apply / Dismiss:** Apply on a flagged in-progress order updates header fields and absorbable line changes,
   clears the flag and audits. A quantity drop below the picked quantity, or removing a packed line, is refused
   with `errors.sync.cannotApply` and an unmet list, and nothing changes. Dismiss needs a reason. Both check
   `expectedVersion`. Both are forbidden for Picker, Packer, QA and Shipper.
7. **Webhooks (FR-SYNC-11):** a correctly signed `order.created` stores one inbox row and imports the order (via
   the job, refetched from the store). A bad or missing signature → 401 and no row. A repeated delivery id →
   200 and no second job. The creation ping → 200. No secret configured → 401.
8. **Schedule and lock (FR-SYNC-09):** with `syncIntervalMinutes = 5`, minute ticks start a poll only when 5
   minutes have passed since the last one started; a manual run starts at once; a run while another holds the lock
   returns `alreadyRunning` and writes nothing.
9. **Products (FR-SYNC-12):** `syncProducts` refreshes weight, dimensions, stock, bin and `physical`, and leaves
   customs, barcode and Lumexia fields alone.
10. **API permissions:** every procedure in the table has an allowed and a forbidden test; `sync.status` works for
    every role and fails signed out. No response contains the consumer key/secret, and no response or log line
    contains `incoming` customer data.
11. **Settings follow-up:** changing `wooStoreUrl`'s host clears the three WooCommerce secrets (audited, reason
    `urlChanged`); changing only its path keeps them; same for Lumexia.
12. **Adapter:** recorded dev-store fixtures parse and map; 429 then 200 succeeds after a retry honouring
    `Retry-After`; 401 → `unauthorized`; a non-Woo URL → `notWooCommerce`. A live test against the dev store
    (`WOO_LIVE=1`, skipped in CI) runs `ping`, `getUnits` and one page of orders.
13. **E2E (desktop, dev stack; `E2E_DEV_STACK=1`, skipped in CI, which has no store or worker):** an admin presses Test connection (OK), then Sync orders now; the seeded
    processing orders appear in the Pending queue and the nav shows a fresh sync time. A signed request to the
    webhook route for an order edited in the dev store shows the external-change banner on its detail page.
14. Green: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`, plus the Playwright suite.

## Assumptions

1. Only `processing` orders are imported (paid and ready to fulfil); `on-hold` (awaiting payment) orders wait
   until the store moves them to processing.
2. Webhooks are registered by hand in WooCommerce → Settings → Advanced → Webhooks (two webhooks, API v3, the
   saved webhook secret). Auto-registration would write to the real store, so it's left out.
3. The store's weight and dimension units are read from the store on every run rather than assumed (the dev
   store uses `lbs`).
4. Customer name comes from the shipping address (that's who receives the box), falling back to billing.
5. A partial refund never voids lines by itself; `exceptions` will offer "void the refunded quantity".
6. Catalog sync never deletes products; old orders keep pointing at them.

## Decisions (2026-10-15)

1. **Store cancels/refunds an imported order:** untouched → cancelled automatically; already started → On Hold
   ("Cancelled in store") + flagged for an admin.
2. **Store edits an imported order:** untouched → applied automatically (audited); started → flagged for an
   admin's Apply / Dismiss.
3. **Integration URL change:** an origin change clears that integration's stored secrets.
4. **Cron endpoint:** dropped. Sync runs on the worker schedule, from the admin button and from `pnpm sync:pull`.

## Decisions (2026-10-19, from a read-only pull of the production store)

A read-only pull (`scripts/realtest/`: 54 processing orders, 133 lines, 115 products, 99 variations) answered
the earlier open questions and raised new ones. Decided with the user:

1. **Bins:** the store keeps no bin locations, and none are added for now. Sync still reads `_bin_location` meta
   if it ever appears (harmless); pick lists sort without bins (`picking` spec).
2. **Bundles / ACF:** closed. Production has only simple and variable products (`woobt_*` is a "frequently
   bought together" upsell, not a bundle) and orders carry no ACF data. The `bundled_by` support stays.
3. **Rush Order:** confirmed virtual (SKU `RUSH`), so it imports with `physical = false`.
4. **First import:** import every `processing` order (54 today, the oldest 30 days old).
5. **Line options and sizes:** variation attributes (container size, pack) and the options-plugin choices
   ("Assistance Lowering the Pallets?", "No Liftgate Confirmation", "Specific Delivery Window?", "Add Batch
   Priority Pass") are already stored in `OrderItem.attributes`. They're shown under each line on the order page
   and pick list, and priority rules can match them (e.g. Batch Priority Pass raises priority). The display is a
   small follow-up here; option matching extends `workflow`'s priority-rule conditions.
6. **Freight (pallet) orders:** 400–500 lb drums go through the floor flow (pick, pack, QA) in Woolrus, and the
   LTL shipment is booked by hand and recorded (carrier, PRO number) instead of buying a label. Detailed in
   `carriers` / `shipping`.
7. **Weights and dimensions:** weights are kept in WooCommerce, on the variation for variable products (every
   physical line has one); sync keeps them current. Dimensions are never kept, so there is no automatic box
   suggestion (`packing` spec: the packer picks the box).
8. **Shipping charged:** `shippingChargedCents` = Σ `shipping_lines` **minus** fee lines named
   "… Shipping Discount" (the store's "Free Shipping Discount" and "Courtesy Shipping Discount"), so #26230 records
   $0.00 and #26237 $18.83. Other fees stay in `rawPayload` only.
9. **ShipStation:** today orders reach ShipStation through its own WooCommerce import because labels are bought
   there. After go-live staff stop using ShipStation's screens and labels are bought through Woolrus, so that import
   just goes unused and can be switched off when convenient. No double-label risk.

Checked and not an issue: `_order_number` equals `number` on every order; no lines point at deleted products.

## Known limits (accepted at ship, 2026-10-19)

From the ship review; none affects correctness of what's stored, and each has a natural owner:
- A captured signed webhook body can be replayed with new delivery ids: each one only refetches the order from the
  store. Rate limiting the webhook path belongs at the reverse proxy (`operations`).
- Store responses aren't size-capped.
- In development only, env credentials can follow a moved store URL (production reads Settings only).
- The `localhost` URL exemption applies in production too (admin-only setting).
- A worker crash leaves its `SyncRun` RUNNING; a sweep belongs with `operations`' health checks.
- The first import pages by offset: an order leaving `processing` mid-run could be skipped (54 orders today, one
  page).
- Inbound webhook payloads and `rawPayload` keep customer data until `operations` adds the PII purge.

## Open questions

None open. Done here: line attributes on the order page (5; `OrderLine.attributes`) and shipping charged net of
shipping-discount fees (8). Left for other modules: attributes on the pick list (`picking`) and priority-rule
conditions on line options (5, `workflow`).
