# Implementation Plan: `settings`

Spec: [`docs/specs/SPEC-settings.md`](../docs/specs/SPEC-settings.md) (approved 2026-10-14).
Branch: `settings/settings-module`. Tasks: [`todo.md`](todo.md).

## Overview

An encrypted secret store and a typed settings service in core, exposed through five oRPC procedures. On top of
that: an admin `/settings` page (General + Integrations), a `formatWeight` helper that the boxes page uses, and an
`encryption` check in `/api/health`. The `Settings` table already has every column, so there are no schema changes.

## What the codebase gives us / lacks

- **Has:** the contract → core → one-line route pattern (`boxes`), `assertCan`, `recordAudit`, `AppError` with
  `fields`, `testDb`/`resetDb`/`createActor`, a seeded settings row, React Aria fields, i18n catalog parity test.
- **Lacks (built here because this module needs them first):**
  1. **Signed-in e2e.** The only e2e is signed-out smoke tests. Criterion 8 needs an Admin and a Picker session.
  2. **Field-level validation keys.** Zod failures in contracts reach the client as generic oRPC validation
     errors, with no `data.messageKey`/`data.fields`. Criterion 5 needs field → message key.
  3. **Env plumbing.** Turbo strict mode hides `SETTINGS_ENCRYPTION_KEY` and `WOO_*` from tasks, and CI doesn't
     set the key.

## Architecture decisions

- **Config is read in one place.** `packages/core/src/settings/env.ts` reads `SETTINGS_ENCRYPTION_KEY`, `NODE_ENV`
  and the dev fallback vars from `process.env` lazily. Nothing else in core touches `process.env` for settings.
  Tests use `vi.stubEnv`.
- **No secret hint:** a secret's status is `{ configured }`, from the column being non-null. Reads never decrypt,
  so the page still loads without a key (criterion 7). Only `getIntegrationConfig` decrypts.
- **Validation errors:** contract schemas use i18n keys as Zod messages (e.g. `errors.field.urlHttps`). A
  pure `toFieldErrors(issues)` in `@woolrus/contracts` maps issue paths to keys. The `mapErrors` middleware turns a
  contract validation failure into `BAD_REQUEST { messageKey: "errors.validation", fields }`. Every module gets
  this, not just settings.
- **E2E sign-in:** a Playwright helper creates the user with roles directly in the dev DB, requests a magic link
  through Better Auth's endpoint, reads the token from the `verification` table and opens the verify URL. Existing
  users skip the invite hook, so it doesn't depend on `ADMIN_EMAILS`.
- **Forbidden UX:** the nav link is rendered server-side only if `can(actor, "settings.manage")`. The page itself
  is a client component. A `FORBIDDEN` from `settings.get` renders the translated error, so the rule stays in core.
- **Secrets never round-trip:** output schemas have no secret-valued field (`SecretStatus = { configured }`),
  and the leak test (criterion 3) serializes every response and audit row.

## Dependency graph

```
crypto (T1) ─────────────┐
validation keys (T3) ────┼─> settings contract + core read/update (T4) ─> secrets (T5) ─> integration config + health (T6)
                         │                    │                                  │
                         │                    └─> formatWeight + boxes (T7)      │
                         │                    └─> General UI + nav (T8) ─────────┴─> Integrations UI (T9)
e2e sign-in helper (T2) ─────────────────────────────────────────────────────────────> settings e2e (T10)
```

## Task list

### Phase 1: Foundations (riskiest first)
- [x] T1: Secret encryption (`crypto.ts`)
- [x] T2: Signed-in Playwright helper
- [x] T3: Field-level validation errors through the API

### Checkpoint A: green, plus a signed-in e2e and a field error visible via REST

### Phase 2: Settings API
- [x] T4: Read and update settings (contract + core + routes)
- [ ] T5: Set and clear secrets
- [ ] T6: Integration config for other modules + health `encryption`

### Checkpoint B: criteria 1–7 covered by tests; green

### Phase 3: UI
- [ ] T7: `formatWeight` and the boxes page uses the public setting
- [ ] T8: Settings page, General section + nav gating
- [ ] T9: Settings page, Integrations section
- [ ] T10: Settings e2e

### Checkpoint C: every success criterion has a test; green + Playwright; ready for `/agent-skills:review`

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Better Auth's magic-link storage format (token in `identifier` vs `value`) differs from what the helper assumes | Med | T2 runs first. If it's not readable, fall back to scraping the logged link from the dev server output |
| Hooking oRPC's validation error into `mapErrors` (where the input-validation error surfaces) | Med | T3 proves it on `boxes.create` before settings depends on it |
| Turbo strict env silently hides `SETTINGS_ENCRYPTION_KEY` from `dev`/`build`/`test` | Med | T6 declares it in `turbo.json` and asserts the health check is `ok` in dev |
| Leaking a secret through logs (oRPC error logging of input) | High | Leak test covers responses and audit rows. T5 also checks `setSecret` failures don't log the input |
| JSON settings fields (`shipFromAddress`, `stageSlaMinutes`) stored in a shape that later fails the contract | Low | Core parses stored JSON with the contract schema on read and treats invalid stored data as unset |

## Resolved questions (2026-10-14)

1. **CI key:** approved. CI gets a throwaway, CI-only `SETTINGS_ENCRYPTION_KEY`. It only ever encrypts test data
   in an ephemeral database, so it is not a secret; it must never be reused anywhere else.
2. **Secret hint:** dropped entirely (spec updated).
