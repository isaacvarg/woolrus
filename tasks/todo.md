# Todo: `settings`

Plan: [`plan.md`](plan.md) · Spec: [`SPEC-settings.md`](../docs/specs/SPEC-settings.md).
Focused tests: `pnpm --filter @woolrus/core test -- settings`. Green: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
E2E: `pnpm --filter @woolrus/web test:e2e` (dev stack up).

## Phase 1: Foundations

### T1: Secret encryption ✅
**Description:** Pure AES-256-GCM `encryptSecret`/`decryptSecret` with the `v1:<iv>:<tag>:<ct>` format, plus
`parseEncryptionKey(base64)` that rejects keys that aren't 32 bytes. A typed `SecretDecryptError` covers tampering,
a wrong key and malformed input.
**Acceptance criteria:**
- [x] Round-trip works, and two encryptions of the same value differ (random IV)
- [x] Flipping one byte of the IV, tag or ciphertext, using another key, or a malformed string throws `SecretDecryptError` (criterion 1)
- [x] A key that isn't base64 for 32 bytes is rejected
**Verification:** `pnpm --filter @woolrus/core test -- crypto`; typecheck
**Dependencies:** none
**Files:** `packages/core/src/settings/crypto.ts`, `crypto.test.ts`
**Scope:** XS

### T2: Signed-in Playwright helper ✅
**Description:** `signInAs(page, roles)` creates a user with the roles in the dev DB, requests a magic link via
Better Auth, reads the token from `verification` and opens the verify URL. Proved by one test.
**Acceptance criteria:**
- [x] `signInAs(page, ["ADMIN"])` then `/boxes` shows the Boxes heading (no redirect to sign-in)
- [x] Two different users can be signed in, in separate browser contexts, in one test file
**Verification:** `pnpm --filter @woolrus/web test:e2e -- auth-helper` against the dev stack
**Dependencies:** none
**Files:** `apps/web/e2e/support/auth.ts`, `apps/web/e2e/auth-helper.spec.ts`, maybe `apps/web/package.json` (workspace dep on `@woolrus/db` for e2e)
**Scope:** S

### T3: Field-level validation errors through the API ✅
**Description:** A contract input that fails Zod returns `BAD_REQUEST` with `data.messageKey = "errors.validation"`
and `data.fields` (dotted path → message key). Schemas use i18n keys as messages. Other Zod messages map by issue code to
`errors.field.tooSmall`/`tooBig`/`invalid` (`errors.validation` is the form-level string, so field keys live under
`errors.field.*`).
**Acceptance criteria:**
- [x] Unit: `toFieldErrors(issues)` maps nested paths (`shipFromAddress.state`) and falls back for non-key messages
- [x] `POST /api/v1/boxes` with `lengthIn: -1` (signed in) returns 400 with `fields.lengthIn` set to a key that exists in `en.json`
- [x] `useErrorMessage` callers get the form-level message. A `useFieldErrors(error)` hook returns translated per-field messages
**Verification:** contracts unit test; e2e API check using T2; `pnpm typecheck`
**Dependencies:** T2 (for the e2e check)
**Files:** `packages/contracts/src/base.ts` (+ test), `apps/web/src/server/orpc.ts`, `apps/web/src/lib/errors.ts`, `packages/i18n/src/messages/{en,es}.json`
**Scope:** M

### Checkpoint A
- [x] Green checks pass
- [x] Signed-in e2e and field errors work
- [x] Review with the user before Phase 2

## Phase 2: Settings API

### T4: Read and update settings ✅
**Description:** `packages/contracts/src/settings.ts` holds `AdminSettings`, `PublicSettings`, `UpdateSettingsInput`
(validation table) and the `get`/`public`/`update` procedures. Core adds `getSettings`, `getPublicSettings`,
`updateSettings` (row created on first read; partial; audit of before/after for changed fields only). Each
procedure is wired to a one-line route.
**Acceptance criteria:**
- [x] Admin can get/update. Picker, Packer, QA and Shipper get `errors.forbidden`. Every role can read public settings (criterion 2; the signed-out case is covered by the `authed` middleware and asserted in T10)
- [x] A partial patch changes only the given fields and writes exactly one audit event with before/after for them. An empty or no-op patch writes none (criterion 6)
- [x] Each validation-table row has a rejecting case with the expected field key, and nothing is written (criterion 5)
**Verification:** `pnpm --filter @woolrus/core test -- settings`; contracts schema tests; typecheck
**Dependencies:** T3
**Files:** `packages/contracts/src/{settings,index}.ts`, `packages/core/src/settings/service.ts` (+ test), `packages/core/src/index.ts`, `apps/web/src/server/router.ts`, i18n
**Scope:** M

### T5: Set and clear secrets ✅
**Description:** `setSecret`/`clearSecret` in core, contract and routes (`PUT`/`DELETE /settings/secrets/{name}`).
`getSettings` exposes `SecretStatus { configured }`. A missing or bad key → `errors.settings.encryptionKeyMissing`.
Audit records `secret.set`/`secret.clear` with the name only.
**Acceptance criteria:**
- [x] After `setSecret` the column holds `v1:…`. `getSettings` shows `configured: true` and nothing derived from the value. A leak test serializes every response and audit row and finds no plain value (criterion 3)
- [x] Without the key: `setSecret` fails with `encryptionKeyMissing`, and `getSettings` still succeeds and shows stored secrets as configured (criterion 7, core part)
- [x] Non-admins are forbidden for both. Clearing sets the column to null and audits
**Verification:** `pnpm --filter @woolrus/core test -- settings`
**Dependencies:** T1, T4
**Files:** `packages/contracts/src/settings.ts`, `packages/core/src/settings/{service,env}.ts` (+ test), `apps/web/src/server/router.ts`, i18n
**Scope:** M

### T6: Integration config + health ✅
**Description:** `getIntegrationConfig(db)` (server-internal, not in the contract) returns decrypted config per
integration. Outside production it falls back to env vars for unset values. `/api/health` gains `encryption`
(ok when the key parses). `turbo.json` declares `SETTINGS_ENCRYPTION_KEY` and `WOO_*`. `.env.example` keeps a
generated dev key comment.
**Acceptance criteria:**
- [x] Decrypted values are returned. In production, unset → null even with env vars set. In development, env fills unset values, and stored values win (criterion 4)
- [x] Health reports `encryption: "fail"` (and 503) without a key, and `"ok"` with one (criterion 7)
- [x] `getIntegrationConfig` is exported from core but absent from `contract`
**Verification:** core tests with `vi.stubEnv`; `curl localhost:3000/api/health` in dev; build
**Dependencies:** T5
**Done differently:** no `turbo.json` change. Vitest, Next and Playwright each load the root `.env`
with dotenv in-process, so Turbo's env filtering never applies. The CI key was added here instead of in T10,
because health now returns 503 without a key and CI waits on it.
**Files:** `packages/core/src/settings/{integration,env}.ts` (+ test), `apps/web/src/app/api/health/route.ts`, `turbo.json`, `.env.example`
**Scope:** S

### Checkpoint B
- [x] Criteria 1–7 have passing tests; green checks pass
- [x] Review with the user before Phase 3

## Phase 3: UI

### T7: `formatWeight` + boxes page ✅
**Description:** `formatWeight(oz, weightDisplay, locale)` in core (built on `splitPoundsOunces`/`ouncesToPounds`).
The boxes page reads `settings.public` and formats max weight with it.
**Acceptance criteria:**
- [x] `formatWeight(37, "LB_OZ", "en")` → `"2 lb 5 oz"`, `formatWeight(37, "LB_DECIMAL", "en")` → `"2.31 lb"`; covers 0, a whole number of pounds, rounding to 16 oz, and `es`
- [x] The boxes table shows max weight in the configured format (criterion 9 is proved in T10)
**Verification:** core unit test; the boxes page renders in dev
**Dependencies:** T4
**Done differently:** core also exports `./format` as a client-safe subpath (`@woolrus/core/format`), because the
core index pulls in Prisma and `node:crypto`, which can't go in a client bundle. The table header loses "(lb)" (new
`boxes.maxWeightColumn` key) because cells now carry their own units; the form label keeps it.
**Files:** `packages/core/src/settings/format.ts` (+ test), `packages/core/src/index.ts`, `apps/web/src/app/(app)/boxes/boxes-manager.tsx`, i18n
**Scope:** S

### T8: Settings page, General section + nav ✅
**Description:** `/settings` page with a General form: ship-from, sync interval, idle lock, SLA per stage, weight
display, PII retention, QA rule. One Save button, field errors via `useFieldErrors`. A nav link is shown only with
`settings.manage`. Non-admins see the translated forbidden message.
**Acceptance criteria:**
- [x] An admin edits and saves; values persist after a reload
- [x] Invalid input shows the field-level message next to the field
- [x] A Picker has no nav link, and `/settings` shows "You don't have permission to do that."
**Verification:** dev preview check (desktop + tablet width); i18n parity test
**Dependencies:** T3, T4
**Done differently:** the form saves only the fields that changed since it loaded, so two admins (or the two
parallel e2e projects) editing different fields don't overwrite each other. Weight display is a radio group
(two options), not a Select. `server/actor.ts` adds `currentActor()` so the layout and page can check
`settings.manage`. The tests went into `e2e/settings.spec.ts` now (T10 extends that file).
**Files:** `apps/web/src/app/(app)/settings/{page,general-form}.tsx`, `apps/web/src/app/(app)/layout.tsx`, `apps/web/src/server/actor.ts`, `apps/web/src/components/ui/fields.tsx` (Checkbox, RadioGroup/Radio, field descriptions), `apps/web/e2e/settings.spec.ts`, i18n
**Scope:** M

### T9: Settings page, Integrations section ✅
**Description:** WooCommerce, ShipStation and Lumexia cards: URL fields (Woo, Lumexia) saved with `settings.update`,
and per-secret "Set" / "Not set" with Replace (an empty write-only field) and Clear (with confirm).
**Acceptance criteria:**
- [x] Replace sets the secret, and the field empties afterwards; the status shows "Set"
- [x] Clear returns the secret to "Not set"
- [x] An encryption-key-missing error is shown translated
**Verification:** dev preview check
**Dependencies:** T5, T8
**Done differently:** an unset secret's button reads "Add" (Replace once it is set); Clear asks for confirmation
inline. The encryption-key-missing e2e check stubs the `setSecret` response, since the dev server always has a key
(the server side is covered by T5's core tests). Tests use the webhook secret, never the Woo consumer key/secret the
dev stack falls back on, and clear it again. (After review, every settings-writing test takes turns through
`withSettingsLock` instead of per-project fields.) The General form is now named by its
heading so tests can scope its Save button.
**Files:** `apps/web/src/app/(app)/settings/{integrations,page,general-form}.tsx`, `apps/web/src/components/ui/fields.tsx` (descriptions wrap), `apps/web/e2e/settings.spec.ts`, i18n
**Scope:** S

### T10: Settings e2e ✅
**Description:** `apps/web/e2e/settings.spec.ts` covers criteria 8 and 9 and the signed-out `settings.public` case.
CI env gets a throwaway `SETTINGS_ENCRYPTION_KEY` (approved; CI-only value).
**Acceptance criteria:**
- [x] An admin saves a ship-from address and the Woo consumer secret. After a reload the address is shown, the secret shows "Set" and the input is empty
- [x] A Picker sees no Settings link and gets the forbidden message at `/settings`; anonymous `GET /api/v1/settings/public` → 401
- [x] Switching to `LB_DECIMAL` changes the boxes page's max weight display
**Verification:** `pnpm --filter @woolrus/web test:e2e` (desktop + tablet)
**Dependencies:** T2, T7, T9
**Done differently:** the CI key was already added in T6, so `ci.yml` is unchanged. Tests that change global
settings (address, Woo consumer secret, weight display) take turns across the desktop and tablet workers through a
Postgres advisory lock (`e2e/support/settings-lock.ts`) and restore what they changed. The ship-from address can't be
unset through the API, so the dev DB keeps the e2e address.
**Files:** `apps/web/e2e/settings.spec.ts`, `apps/web/e2e/support/settings-lock.ts`
**Scope:** S

### Checkpoint C
- [x] Every spec success criterion maps to a passing test
- [x] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` + Playwright pass
- [x] `SPEC.md` status → `in progress` (during build); then `/agent-skills:review`
