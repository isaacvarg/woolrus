# Woolrus V2 — Decisions

Agreed on 2026-10-14 while planning the rebuild. The SRS (`Woolrus — System Requirements Specification`) is the
functional reference; where this file disagrees with it, this file wins. Change a decision by editing it here
in the same PR as the code.

## Scope

| Decision | Choice | Notes |
| --- | --- | --- |
| Tenancy | One company, one WooCommerce store, one warehouse | No `storeId`/`warehouseId` across the schema. Ship-from address lives in Settings, not env vars. |
| Scope | The whole SRS, delivered in milestones | Returns are modelled now (tables exist) and built later. |
| Clean start | No data or code carried over from v1 | v1 stays at the `v1-legacy` tag. |
| Lumexia (ERP) | Lot traceability + SKU↔item link now; stock sync later | `PackageItem.lotCode/lumexiaLotId`, `Product.lumexiaItemId`. Lumexia exposes scoped API keys and `/api/items`, `/api/lots`. |

## Platform

| Decision | Choice | Why |
| --- | --- | --- |
| Hosting | Self-hosted Docker on the company network | |
| Floor client | Touch-first PWA on rugged Android tablets | Bluetooth scanners in HID (keyboard) mode work in the browser. Offline is not a hard requirement. |
| Native Android | Later, technology undecided | The API is built for it now: OpenAPI spec, bearer tokens, idempotent mutations. |
| Redis | Not used | Postgres covers jobs (pg-boss), pub/sub (LISTEN/NOTIFY) and sessions at this scale; jobs can be enqueued in the same transaction as the data change. |
| Background jobs | pg-boss in `apps/worker`, schema `pgboss` | Queue names and payloads in `@woolrus/core` (`jobs.ts`). `@woolrus/core` depends on pg-boss too: `enqueue(tx, …)` inserts a job on the caller's Prisma transaction, so web can queue work that exists only if its change commits (2026-10-15). |
| Live updates | Postgres LISTEN/NOTIFY → Server-Sent Events | Not built yet (FR-LIST-06). |

## Stack

- **Monorepo:** pnpm workspaces + Turborepo. Internal packages ship TypeScript source (`exports` → `src/*.ts`); Next.js
  transpiles them, the worker bundles them with tsdown.
- **Web:** Next.js 16 (App Router), React 19, TypeScript strict (TS 6.0.x; TS 7 is skipped until Next/Prisma tooling supports it).
- **Database:** Prisma 7 + Postgres 17, `@prisma/adapter-pg`. IDs are UUIDv7.
- **API:** oRPC. The contract in `@woolrus/contracts` is the single source of truth; `apps/web` implements it and
  serves it twice: `/rpc` (typed client for the web app) and `/api/v1` (REST, spec at `/api/openapi.json`).
- **UI:** Tailwind 4 + daisyUI 5 for styling; React Aria Components for anything interactive and complex
  (fields, combobox, menus, dialogs) so keyboard and screen-reader behaviour comes for free (WCAG 2.2 AA).
  Themes: light, dark, high-contrast (`contrast`).
- **Data fetching:** TanStack Query via oRPC's query utils. No Zustand unless a real need appears.
- **i18n:** next-intl, catalogs in `@woolrus/i18n` (en, es). No locale in URLs; a cookie / user preference picks it.
- **Auth:** Better Auth (Prisma adapter), Google + Discord + magic link, `bearer` plugin for Android.
- **Logging:** pino via `@woolrus/logger`; JSON lines with `requestId`, `userId`, `orderId` bindings.
- **Errors:** GlitchTip (self-hosted, Sentry-compatible, all-in-one on Postgres). SDK not wired yet.
- **Tooling:** Biome (lint + format), Vitest, Playwright (desktop + Galaxy Tab profiles), GitHub Actions.

## Rules the code follows

1. **No Next.js server actions.** Every mutation goes through an oRPC procedure. Server components may call
   `@woolrus/core` directly for reads.
2. **Routes are thin.** A procedure parses input (the contract does it), calls one `@woolrus/core` function, returns.
   Business rules, permissions, gates and state transitions live in core.
3. **Deny by default.** Every procedure passes the `authed` middleware; every core function takes an `Actor`
   and starts with `assertCan(actor, permission)`. Roles are a set per user; permissions are mapped in
   `core/src/permissions.ts`.
4. **Errors carry message keys, not English.** Core throws `AppError(kind, "errors.…")`; the API returns
   `{ data: { messageKey } }`; clients translate. The keys are the API's error codes.
5. **Creating mutations are idempotent.** They take a client-generated `idempotencyKey`; a replay returns the
   stored result (`withIdempotency`).
6. **Audit everything that changes state** (`recordAudit`), and record workflow transitions in `OrderStageEvent`.
7. **Optimistic locking on orders.** Workflow writes check and bump `Order.version`.

## Data model

Full model in `packages/db/prisma/schema/*.prisma`. Changes from the SRS's section 4:

- **Units:** weights in **ounces**, dimensions in **inches** (`Decimal`), money in **integer cents** + currency.
  Everyone and everything upstream (store, ShipStation, carriers, scales, staff) is imperial, and carriers
  round dimensions *up* to the next inch, so storing metric would create billing errors. FR-SET-06 is reduced
  to a display preference (`lb + oz` vs decimal `lb`).
- **`PackageItem`** holds "how many units of which line are in which box". `OrderItem` is never split or merged.
- **`OrderStageEvent`** replaces the per-stage columns of `OrderWorkflow`; `AuditEvent` covers everything else.
- **Labels are never deleted.** `ShippingLabel.status` tracks `PURCHASING → ACTIVE → VOID_REQUESTED → VOIDED`
  (or `PURCHASE_FAILED`, `VOID_REJECTED`); the `idempotencyKey` is recorded before the purchase call.
- **Notes** have `visibility` (internal / customer) and remember `wooNoteId` so nothing is posted twice.
- **Stations, PINs, badges:** `Station`, `StationActivation`, `User.pinHash/badgeCode`. Stations auto-lock after
  `Settings.stationIdleLockMinutes` (default 10).
- **WooCommerce payloads** are stored raw (`rawPayload` jsonb) so fields can be promoted to columns later.
- **Settings** is a single row; secrets are stored AES-GCM-encrypted with `SETTINGS_ENCRYPTION_KEY`.
- **Returns** (`ReturnRequest`, `ReturnItem`), **manifests**, **priority rules**, **webhook inbox** and
  **idempotent requests** have tables already.

Constraints Prisma can't express are hand-written at the end of the init migration: one live label per package,
one selected rate per package, a label belongs to a package *or* a return, a note has at most one narrow target,
positive quantities and dimensions, single-row settings. **Keep them when editing migrations.**

## Integrations

- **WooCommerce:** REST v3 only (no WPGraphQL / WooGraphQL Pro) + `order.created`/`order.updated` webhooks with
  polling as fallback. Auth is basic auth with a consumer key/secret (HTTPS in production).
- **No sync cron endpoint** (2026-10-15): FR-SYNC-08's `POST /api/sync/pull` + `SYNC_SECRET` is replaced by the
  worker's schedule (a 1-minute tick honouring `Settings.syncIntervalMinutes`), the admin's **Sync orders now**
  and `pnpm sync:pull`. No shared secret to leak, and nothing outside the app can start a sync.
- **Integration URL moves clear secrets** (2026-10-15): when `wooStoreUrl` or `lumexiaBaseUrl` changes origin
  (scheme, host or port) or is removed, that integration's saved secrets are cleared in the same update (audited
  `secret.clear`, reason `urlChanged`), so keys never follow a URL to another server. A path-only change, or a
  first URL where there was none, keeps them. Exception (2026-10-27, carriers ship review): Bridge Source has no
  default host, so its first base URL is a move too, and credentials saved before it are cleared.
- **Shipping providers** (2026-10-27, SPEC-carriers): labels go through a `ShippingProvider` seam, one adapter per
  provider, each enabled separately with its own encrypted credentials (`ShippingProviderAccount`); only enabled
  providers are queried and their rates are merged, cheapest pre-selected. **ShipStation** API v2 is the first
  (UPS is reached through it, no UPS adapter); **Bridge Source** follows as module `bridge-source`. The ShipStation
  key moves from `Settings` to its provider account.
- **Ship-to fallback never mixes locations** (2026-10-27, carriers review; changes FR-SHIP-03): the street, line 2,
  city, state, postal code and country come from the shipping address as a block, or from billing as a block when
  shipping has none of them. A partial shipping location is `INCOMPLETE`, not filled from billing. Name, company,
  phone and email still fall back field by field. v1 fell back field by field for everything, which could put
  billing's apartment on the shipping street.
- **Lumexia:** its REST API with a scoped API key. **Storage:** S3-compatible (RustFS).
  Each sits behind an adapter interface in core so it can be swapped. Storage is reached with `aws4fetch`-signed
  `fetch` (path-style, `S3_*` env); its bucket is created private if missing when the worker starts and on first use
  in web, and health reports `storage`.
- **Note attachments are served through the app, not signed URLs** (2026-10-20, SPEC-notes decision 1; deviation
  from FR-NOTE-03). `GET /api/attachments/{id}` and `/thumb` resolve the actor, check `order.read` on every
  request and stream from storage (`Cache-Control: private, max-age=3600, immutable`, `nosniff`, inline). Storage
  stays off the floor network, no URL grants access by itself (NFR-SEC-05), and listing notes signs nothing
  (NFR-PERF-03). Photos are stored only as the processed WebP (2048 px, metadata stripped) plus a 400 px thumbnail.
- **Email provider: Resend** (2026-10-20, SPEC-identity decision 1), through its HTTP API with `fetch`, no SDK:
  `POST https://api.resend.com/emails` with `Idempotency-Key`. Behind the `EmailSender` adapter in
  `packages/core/src/adapters/email/`; configured by `Settings.emailFrom` and the `resendApiKey` secret. Without a
  key the log sender is used and health reports `email: "unconfigured"` (a go-live blocker in production). 4xx is a
  permanent failure; 429/5xx retry through pg-boss. Magic links are sent right after the response (never queued), invitations by the `email.send` job.

## Deployment

- CI builds three images from `docker/Dockerfile` — `web`, `worker`, `migrate` — and pushes them to GHCR
  (`ghcr.io/isaacvarg/woolrus-*`).
- The host runs `docker/compose.prod.yml`: `migrate` runs and exits, then `web` and `worker` start.
  Upgrade with `docker compose -f compose.prod.yml pull && docker compose -f compose.prod.yml up -d`.

## Open items

- **WooCommerce plugins:** pull real orders from the production store and check `meta_data` for ACF fields and
  bundle/composite line items before modelling them (we don't know yet whether ACF matters for orders).
- **Google / Discord OAuth apps** need creating; redirect URI `https://<host>/api/auth/callback/<provider>`.
- **GHCR visibility:** if the repo is private, the host needs `docker login ghcr.io` with a read-only token.
- **Note upload memory** (notes review, 2026-10-21): a full note upload (10 photos at the 15 MB limit, 160 MB
  request cap) peaks around 300 MB in web: the parsed multipart body plus `preparePhotos`' copies, which are all
  checked before any is processed. Decoding one 40-megapixel photo with sharp adds about 160 MB. Three full uploads
  at once could exhaust a small host. Real tablet photos are 3–5 MB, so this is unlikely today. Before production:
  size the web container for it, or limit concurrent note uploads, or check each photo from its header and drop
  its bytes before the next is read.
- **Voice memo checks** (notes ship review, 2026-10-21): a voice memo is accepted by its container's magic bytes
  and stored as uploaded, up to 15 MB; `durationMs` comes from the client and is only range-checked. So any
  signed-in user can store arbitrary bytes behind an audio header (an MP4 video passes as `audio/mp4`), and
  nothing limits uploads per user. Served as `audio/*` with `nosniff` and a sandbox CSP, so it can't run in the
  browser. Before production: a per-user upload rate limit and byte budget, refusing memos far larger than
  their duration allows (about 40 bytes per ms), refusing MP4s with a video track, and tracking bucket size.
