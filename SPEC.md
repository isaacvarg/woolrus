# Spec: Woolrus V2

The index of all work: what we're building, the capability map, the roadmap, and the project-wide rules every
module spec inherits. **Module specs live in [`docs/specs/`](docs/specs/), named `SPEC-<module-id>.md`. This map —
not filename guessing — is the list of what exists.**

Sources, in order of precedence: [`docs/decisions.md`](docs/decisions.md) (agreed architecture) →
this file → module specs → [`docs/srs.md`](docs/srs.md) (requirements, reverse-engineered from v1).

## Objective

Rebuild Woolrus — the warehouse workspace between our WooCommerce store and the carriers — so that staff can pull
paid orders in, pick, pack, QA, buy labels and ship from one app, with every rule enforced on the server.

- **Users:** Admin, Picker, Packer, QA, Shipper (a person can hold several roles). Floor staff work on shared
  rugged Android tablets with Bluetooth scanners (PWA); admins on desktops.
- **Success:** after milestone M4 the warehouse ships every order through Woolrus instead of by hand (v1 was
  never live). At that point every SRS requirement tagged *Existing* works, the defects in SRS §7.1 are fixed, and
  the go-live checklist below passes.

## Capability map

| Module id | Responsibility | SRS | Depends on |
|---|---|---|---|
| `settings` | Encrypted secret store, settings service and admin UI, ship-from, display units, SLA thresholds | FR-SET-05/06, FR-SHIP-09 | — |
| `store-sync` | WooCommerce REST adapter, product and order import, change detection, webhook inbox, sync log, scheduled and manual sync | FR-SYNC-01…12 | settings |
| `workflow` | State machine and gates in core, hold/cancel, claiming, stage events, optimistic locking, queues and All Orders, priority rules, SLA, live updates | FR-WF-\*, FR-LIST-\* | — (data model only) |
| `identity` | Invitations, user and role admin, deactivation, stations, PIN/badge switching, idle lock, email provider | FR-SET-03/04, NFR-SEC-02 | settings |
| `notes` | Notes and attachments, storage adapter, visibility, author rules, upload limits | FR-NOTE-\* | workflow |
| `picking` | Pick cards, scan to confirm, out-of-stock/substituted, bin sort, batch pick list | FR-PICK-\* | workflow |
| `packing` | Box admin, packages, PackageItem split/merge, weights and overrides, box suggestion, scale | FR-PACK-\*, FR-SET-01 | workflow |
| `exceptions` | Item voids (including partial) and quality issues | FR-VOID-\*, FR-QI-01…06/08 | workflow, notes, picking |
| `carriers` | `ShippingProvider` seam, provider toggles and credentials, carrier and service settings, rates merged across enabled providers with expiry, address validation, ShipStation adapter (UPS through it) | FR-SHIP-01…03/12, FR-SET-02 | settings, packing |
| `bridge-source` | Bridge Source adapter implementing `ShippingProvider` | decisions.md | carriers |
| `qa` | Per-item verification, rate choice, idempotent label purchase, blocking on open critical issues | FR-QA-\* | carriers, exceptions |
| `shipping` | Ready queue, print separate from ship, merged PDF, repack/void, Woo push with retries, customs, manifests | FR-SHIP-04…14 | qa, store-sync |
| `lumexia` | Lot capture and validation, SKU↔item link | decisions.md | packing, settings |
| `returns` | RMA flow, return labels, restock | SRS §7.2 #9 | shipping, exceptions |
| `reporting` | Home dashboard, throughput, cycle time, spend, quality dashboard, CSV export | FR-REP-\*, FR-QI-07 | shipping, exceptions |
| `operations` | GlitchTip SDK, per-adapter health checks, PII purge, structured log coverage | NFR-OPS-\*, NFR-SEC-06 | — (runs alongside) |

Module ids are permanent. If two modules turn out to need each other, merge them rather than adding a cycle.
The contract between two modules belongs in the **provider's** spec.

## Roadmap

| Milestone | Modules (→ sequential, ∥ parallel) | Outcome |
|---|---|---|
| **M1 Orders in** | `settings` → `store-sync` ∥ `workflow` | Real orders flow in from WooCommerce and move through server-enforced states |
| **M2 People & floor** | `identity` ∥ `notes` → `picking` ∥ `packing` | Invited staff sign in on stations and pick and pack orders |
| **M3 Problems** | `exceptions` | Voids and quality issues are recorded and resolved |
| **M4 Ship — go-live** | `carriers` → `qa` ∥ `bridge-source` → `shipping`; `operations` done | Labels bought safely from every enabled provider, orders shipped and pushed to Woo. **First real labels bought in Woolrus** (v1 was never live; shipping is manual today). |
| **M5 Beyond v1** | `lumexia` ∥ `returns` ∥ `reporting` | Traceability, returns, insight |

### Status

Update this table in the same PR that changes a module's state. Each module's spec issue on GitHub tracks its
tickets (see *Work tracking* in `CLAUDE.md`).
States: `not started` → `spec draft` → `spec approved` → `planned` → `in progress` → `done`.

| Module | Milestone | Spec | Issue | State |
|---|---|---|---|---|
| `settings` | M1 | [SPEC-settings](docs/specs/SPEC-settings.md) | [#18](https://github.com/isaacvarg/woolrus/issues/18) | done |
| `store-sync` | M1 | [SPEC-store-sync](docs/specs/SPEC-store-sync.md) | [#19](https://github.com/isaacvarg/woolrus/issues/19) | done |
| `workflow` | M1 | [SPEC-workflow](docs/specs/SPEC-workflow.md) | [#20](https://github.com/isaacvarg/woolrus/issues/20) | done |
| `identity` | M2 | [SPEC-identity](docs/specs/SPEC-identity.md) | [#21](https://github.com/isaacvarg/woolrus/issues/21) | done |
| `notes` | M2 | [SPEC-notes](docs/specs/SPEC-notes.md) | [#22](https://github.com/isaacvarg/woolrus/issues/22) | done |
| `picking` | M2 | [SPEC-picking](docs/specs/SPEC-picking.md) | [#23](https://github.com/isaacvarg/woolrus/issues/23) | done |
| `packing` | M2 | [SPEC-packing](docs/specs/SPEC-packing.md) | [#24](https://github.com/isaacvarg/woolrus/issues/24) | done |
| `exceptions` | M3 | [SPEC-exceptions](docs/specs/SPEC-exceptions.md) | [#25](https://github.com/isaacvarg/woolrus/issues/25) | done |
| `carriers` | M4 | [SPEC-carriers](docs/specs/SPEC-carriers.md) | [#26](https://github.com/isaacvarg/woolrus/issues/26) | done |
| `bridge-source` | M4 | — | [#83](https://github.com/isaacvarg/woolrus/issues/83) | not started |
| `qa` | M4 | [SPEC-qa](docs/specs/SPEC-qa.md) | [#27](https://github.com/isaacvarg/woolrus/issues/27) | done |
| `shipping` | M4 | — | [#28](https://github.com/isaacvarg/woolrus/issues/28) | not started |
| `operations` | M4 | — | [#29](https://github.com/isaacvarg/woolrus/issues/29) | not started |
| `lumexia` | M5 | — | [#30](https://github.com/isaacvarg/woolrus/issues/30) | not started |
| `returns` | M5 | — | [#31](https://github.com/isaacvarg/woolrus/issues/31) | not started |
| `reporting` | M5 | — | [#32](https://github.com/isaacvarg/woolrus/issues/32) | not started |

**Next up:** pick the first module in roadmap order whose dependencies are `done` and whose own state isn't `done`.

### Go-live checklist (end of M4)

- [ ] One order goes import → pick → pack → QA → label → ship → Woo shows Completed + tracking, as a Playwright test
      against the dev stack.
- [ ] Every SRS §7.1 defect has a test proving it can't happen.
- [ ] Every API procedure is covered by a "forbidden for the wrong role" test.
- [ ] Health checks green for database, storage, WooCommerce and every enabled shipping provider; GlitchTip
      receiving errors.
- [ ] Production stack deployed from GHCR images on the host; backup and restore of Postgres rehearsed.

## Tech stack

Recorded in [`docs/decisions.md`](docs/decisions.md) § Stack. In short: pnpm 12 + Turborepo, Node 24, TypeScript 6,
Next.js 16, React 19, Prisma 7 / Postgres 17, oRPC 1.15, Zod 4, Better Auth 1.7, pg-boss 12, Tailwind 4 +
daisyUI 5 + React Aria Components, next-intl 4, pino, Vitest 5, Playwright, Biome. **Adding a dependency is an
ask-first change.**

## Commands

```bash
pnpm install                                   # install everything
pnpm stack:up                                  # dev Postgres :5442, RustFS :9010, WooCommerce :8090
pnpm db:migrate && pnpm db:seed                # apply migrations, seed settings + boxes
pnpm dev                                       # web :3000 + worker, watch mode
pnpm lint                                      # Biome check (pnpm format to fix)
pnpm typecheck                                 # tsc across all packages
pnpm test                                      # Vitest unit + integration (uses TEST_DATABASE_URL)
pnpm --filter @woolrus/web test:e2e            # Playwright, desktop + tablet
pnpm --filter @woolrus/db migrate:check        # schema and migrations agree
pnpm build                                     # production build of web + worker
docker build -f docker/Dockerfile --target web .   # also: worker, migrate
```

The definition of "green": `pnpm lint && pnpm typecheck && pnpm test && pnpm build` all pass, plus e2e for UI changes.

## Project structure

```
apps/web/src/app/            Next.js routes; (app)/ requires a session
apps/web/src/server/         auth, oRPC middleware (orpc.ts), router.ts (one line per procedure)
apps/web/src/lib/            client-side API client, auth client, error translation
apps/web/src/components/ui/  React Aria + daisyUI primitives
apps/web/e2e/                Playwright specs
apps/worker/src/             pg-boss worker; job handlers call core
packages/contracts/src/      one file per area: Zod schemas + oRPC procedures
packages/core/src/<area>/    domain services + co-located *.test.ts
packages/core/src/adapters/  interfaces + implementations for WooCommerce, shipping providers, storage, Lumexia
packages/core/test/          test helpers (testDb, resetDb, createActor)
packages/db/prisma/schema/   Prisma schema, one file per area; migrations alongside
packages/i18n/src/messages/  en.json, es.json (identical key sets, enforced by a test)
docs/                        decisions.md, srs.md, specs/
.claude/commands/            project slash commands (/ticket)
```

## Code style

Biome formats (2 spaces, double quotes, 100 columns). Names are camelCase in TypeScript, snake_case in Postgres
(`@map`). Each feature follows the same path — contract → core → one-line route:

```ts
// packages/core/src/boxes/service.ts
export async function archiveBox(db: Db, actor: Actor, { id }: { id: string }): Promise<BoxDto> {
  assertCan(actor, "box.manage");                       // 1. deny by default
  return db.$transaction(async (tx) => {                // 2. one transaction per use case
    const existing = await tx.box.findUnique({ where: { id } });
    if (!existing) throw notFound();                    // 3. AppError with an i18n key, never English
    const box = toBoxDto(await tx.box.update({ where: { id }, data: { archivedAt: new Date() } }));
    await recordAudit(tx, actor, { entityType: "Box", entityId: id, action: "archive" }); // 4. audit
    return box;                                         // 5. return a DTO from contracts, not a Prisma row
  });
}

// apps/web/src/server/router.ts
archive: api.boxes.archive.handler(({ input, context }) => archiveBox(db, context.actor, input)),
```

- Services take `db` and `actor` explicitly; no globals inside core.
- External systems are reached only through an adapter interface in `core/src/adapters`, injected into services,
  so tests use fakes.
- UI strings come from `@woolrus/i18n`; no literal English in components.
- Comments explain *why*; requirement IDs (e.g. `FR-SYNC-10`) are cited where a rule comes from the SRS.

## Testing strategy

| Level | Tool | Where | Covers |
|---|---|---|---|
| Unit | Vitest | `packages/*/src/**/*.test.ts` | Pure logic: state machine, gates, split/merge, units, crypto |
| Integration | Vitest + real Postgres (`woolrus_test`) | `packages/core/src/**/*.test.ts` | Services end to end through Prisma: permissions, transactions, audit, idempotency |
| Adapter | Vitest + recorded fixtures; dev WooCommerce for opt-in live tests | `packages/core/src/adapters/**` | Mapping external payloads; live tests are tagged and skipped in CI |
| End to end | Playwright (desktop + Galaxy Tab) | `apps/web/e2e` | User journeys per module; the full order journey by go-live |

- Write the failing test first (TDD); every bug fix starts with a test that reproduces it.
- Every new procedure gets an "allowed" and a "forbidden" test.
- No coverage percentage target; the bar is "every acceptance criterion in the module spec has a test".

## Boundaries

- **Always:** keep the module's spec and the status table current in the same PR; run the green checks before
  committing; validate input with the contract's Zod schema; put rules in core, not routes or components; add
  both `en` and `es` strings; audit state changes; keep the hand-written SQL constraints when touching migrations.
- **Ask first:** Prisma schema or migration changes beyond what the module spec lists; new dependencies; changes to
  CI, Docker or compose files; changes to `docs/decisions.md`; anything touching a real (non-dev) WooCommerce,
  ShipStation or Lumexia account; work outside the module currently in progress.
- **Never:** commit secrets or `.env` files; return secret values from any API; call external services from routes
  or components directly; use Next.js server actions; delete or skip a failing test to get green; delete label
  rows; touch the v1 stack or its data (compose project `woolrus`, ports 5432/8080/9000).

## Open questions

Tracked per module in each spec's *Open questions* section, and cross-cutting ones in `docs/decisions.md` § Open items.
