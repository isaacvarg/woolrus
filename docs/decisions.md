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
| Background jobs | pg-boss in `apps/worker`, schema `pgboss` | Queue names and payloads in `@woolrus/core` (`jobs.ts`). |
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
- **ShipStation:** API v2. **Lumexia:** its REST API with a scoped API key. **Storage:** S3-compatible (RustFS).
  Each sits behind an adapter interface in core so it can be swapped.

## Deployment

- CI builds three images from `docker/Dockerfile` — `web`, `worker`, `migrate` — and pushes them to GHCR
  (`ghcr.io/isaacvarg/woolrus-*`).
- The host runs `docker/compose.prod.yml`: `migrate` runs and exits, then `web` and `worker` start.
  Upgrade with `docker compose -f compose.prod.yml pull && docker compose -f compose.prod.yml up -d`.

## Open items

- **WooCommerce plugins:** pull real orders from the production store and check `meta_data` for ACF fields and
  bundle/composite line items before modelling them (we don't know yet whether ACF matters for orders).
- **Email provider** for magic links (and GlitchTip). Until then the link is logged by the web server.
- **Google / Discord OAuth apps** need creating; redirect URI `https://<host>/api/auth/callback/<provider>`.
- **GHCR visibility:** if the repo is private, the host needs `docker login ghcr.io` with a read-only token.
- **Storage bucket** is not created automatically yet; the storage adapter should ensure it on startup.
