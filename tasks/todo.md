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

### T2: Signed-in Playwright helper
**Description:** `signInAs(page, roles)` creates a user with the roles in the dev DB, requests a magic link via
Better Auth, reads the token from `verification` and opens the verify URL. Proved by one test.
**Acceptance criteria:**
- [ ] `signInAs(page, ["ADMIN"])` then `/boxes` shows the Boxes heading (no redirect to sign-in)
- [ ] Two different users can be signed in, in separate browser contexts, in one test file
**Verification:** `pnpm --filter @woolrus/web test:e2e -- auth-helper` against the dev stack
**Dependencies:** none
**Files:** `apps/web/e2e/support/auth.ts`, `apps/web/e2e/auth-helper.spec.ts`, maybe `apps/web/package.json` (workspace dep on `@woolrus/db` for e2e)
**Scope:** S

### T3: Field-level validation errors through the API
**Description:** A contract input that fails Zod returns `BAD_REQUEST` with `data.messageKey = "errors.validation"`
and `data.fields` (dotted path → message key). Schemas use i18n keys as messages. Unknown messages fall back to
`errors.validation.invalid`.
**Acceptance criteria:**
- [ ] Unit: `toFieldErrors(issues)` maps nested paths (`shipFromAddress.state`) and falls back for non-key messages
- [ ] `POST /api/v1/boxes` with `lengthIn: -1` (signed in) returns 400 with `fields.lengthIn` set to a key that exists in `en.json`
- [ ] `useErrorMessage` callers get the form-level message. A `useFieldErrors(error)` hook returns translated per-field messages
**Verification:** contracts unit test; e2e API check using T2; `pnpm typecheck`
**Dependencies:** T2 (for the e2e check)
**Files:** `packages/contracts/src/base.ts` (+ test), `apps/web/src/server/orpc.ts`, `apps/web/src/lib/errors.ts`, `packages/i18n/src/messages/{en,es}.json`
**Scope:** M

### Checkpoint A
- [ ] Green checks pass
- [ ] Signed-in e2e and field errors work
- [ ] Review with the user before Phase 2

## Phase 2: Settings API

### T4: Read and update settings
**Description:** `packages/contracts/src/settings.ts` holds `AdminSettings`, `PublicSettings`, `UpdateSettingsInput`
(validation table) and the `get`/`public`/`update` procedures. Core adds `getSettings`, `getPublicSettings`,
`updateSettings` (row created on first read; partial; audit of before/after for changed fields only). Each
procedure is wired to a one-line route.
**Acceptance criteria:**
- [ ] Admin can get/update. Picker, Packer, QA and Shipper get `errors.forbidden`. Every role can read public settings (criterion 2; the signed-out case is covered by the `authed` middleware and asserted in T10)
- [ ] A partial patch changes only the given fields and writes exactly one audit event with before/after for them. An empty or no-op patch writes none (criterion 6)
- [ ] Each validation-table row has a rejecting case with the expected field key, and nothing is written (criterion 5)
**Verification:** `pnpm --filter @woolrus/core test -- settings`; contracts schema tests; typecheck
**Dependencies:** T3
**Files:** `packages/contracts/src/{settings,index}.ts`, `packages/core/src/settings/service.ts` (+ test), `packages/core/src/index.ts`, `apps/web/src/server/router.ts`, i18n
**Scope:** M

### T5: Set and clear secrets
**Description:** `setSecret`/`clearSecret` in core, contract and routes (`PUT`/`DELETE /settings/secrets/{name}`).
`getSettings` exposes `SecretStatus { configured }`. A missing or bad key → `errors.settings.encryptionKeyMissing`.
Audit records `secret.set`/`secret.clear` with the name only.
**Acceptance criteria:**
- [ ] After `setSecret` the column holds `v1:…`. `getSettings` shows `configured: true` and nothing derived from the value. A leak test serializes every response and audit row and finds no plain value (criterion 3)
- [ ] Without the key: `setSecret` fails with `encryptionKeyMissing`, and `getSettings` still succeeds and shows stored secrets as configured (criterion 7, core part)
- [ ] Non-admins are forbidden for both. Clearing sets the column to null and audits
**Verification:** `pnpm --filter @woolrus/core test -- settings`
**Dependencies:** T1, T4
**Files:** `packages/contracts/src/settings.ts`, `packages/core/src/settings/{service,env}.ts` (+ test), `apps/web/src/server/router.ts`, i18n
**Scope:** M

### T6: Integration config + health
**Description:** `getIntegrationConfig(db)` (server-internal, not in the contract) returns decrypted config per
integration. Outside production it falls back to env vars for unset values. `/api/health` gains `encryption`
(ok when the key parses). `turbo.json` declares `SETTINGS_ENCRYPTION_KEY` and `WOO_*`. `.env.example` keeps a
generated dev key comment.
**Acceptance criteria:**
- [ ] Decrypted values are returned. In production, unset → null even with env vars set. In development, env fills unset values, and stored values win (criterion 4)
- [ ] Health reports `encryption: "fail"` (and 503) without a key, and `"ok"` with one (criterion 7)
- [ ] `getIntegrationConfig` is exported from core but absent from `contract`
**Verification:** core tests with `vi.stubEnv`; `curl localhost:3000/api/health` in dev; build
**Dependencies:** T5
**Files:** `packages/core/src/settings/{integration,env}.ts` (+ test), `apps/web/src/app/api/health/route.ts`, `turbo.json`, `.env.example`
**Scope:** S

### Checkpoint B
- [ ] Criteria 1–7 have passing tests; green checks pass
- [ ] Review with the user before Phase 3

## Phase 3: UI

### T7: `formatWeight` + boxes page
**Description:** `formatWeight(oz, weightDisplay, locale)` in core (built on `splitPoundsOunces`/`ouncesToPounds`).
The boxes page reads `settings.public` and formats max weight with it.
**Acceptance criteria:**
- [ ] `formatWeight(37, "LB_OZ", "en")` → `"2 lb 5 oz"`, `formatWeight(37, "LB_DECIMAL", "en")` → `"2.31 lb"`; covers 0, a whole number of pounds, rounding to 16 oz, and `es`
- [ ] The boxes table shows max weight in the configured format (criterion 9 is proved in T10)
**Verification:** core unit test; the boxes page renders in dev
**Dependencies:** T4
**Files:** `packages/core/src/settings/format.ts` (+ test), `packages/core/src/index.ts`, `apps/web/src/app/(app)/boxes/boxes-manager.tsx`, i18n
**Scope:** S

### T8: Settings page, General section + nav
**Description:** `/settings` page with a General form: ship-from, sync interval, idle lock, SLA per stage, weight
display, PII retention, QA rule. One Save button, field errors via `useFieldErrors`. A nav link is shown only with
`settings.manage`. Non-admins see the translated forbidden message.
**Acceptance criteria:**
- [ ] An admin edits and saves; values persist after a reload
- [ ] Invalid input shows the field-level message next to the field
- [ ] A Picker has no nav link, and `/settings` shows "You don't have permission to do that."
**Verification:** dev preview check (desktop + tablet width); i18n parity test
**Dependencies:** T3, T4
**Files:** `apps/web/src/app/(app)/settings/{page,general-form}.tsx`, `apps/web/src/app/(app)/layout.tsx`, `apps/web/src/components/ui/fields.tsx` (Select/Checkbox if missing), i18n
**Scope:** M

### T9: Settings page, Integrations section
**Description:** WooCommerce, ShipStation and Lumexia cards: URL fields (Woo, Lumexia) saved with `settings.update`,
and per-secret "Set" / "Not set" with Replace (an empty write-only field) and Clear (with confirm).
**Acceptance criteria:**
- [ ] Replace sets the secret, and the field empties afterwards; the status shows "Set"
- [ ] Clear returns the secret to "Not set"
- [ ] An encryption-key-missing error is shown translated
**Verification:** dev preview check
**Dependencies:** T5, T8
**Files:** `apps/web/src/app/(app)/settings/integrations.tsx`, `page.tsx`, i18n
**Scope:** S

### T10: Settings e2e
**Description:** `apps/web/e2e/settings.spec.ts` covers criteria 8 and 9 and the signed-out `settings.public` case.
CI env gets a throwaway `SETTINGS_ENCRYPTION_KEY` (approved; CI-only value).
**Acceptance criteria:**
- [ ] An admin saves a ship-from address and the Woo consumer secret. After a reload the address is shown, the secret shows "Set" and the input is empty
- [ ] A Picker sees no Settings link and gets the forbidden message at `/settings`; anonymous `GET /api/v1/settings/public` → 401
- [ ] Switching to `LB_DECIMAL` changes the boxes page's max weight display
**Verification:** `pnpm --filter @woolrus/web test:e2e` (desktop + tablet)
**Dependencies:** T2, T7, T9
**Files:** `apps/web/e2e/settings.spec.ts`, `.github/workflows/ci.yml`
**Scope:** S

### Checkpoint C
- [ ] Every spec success criterion maps to a passing test
- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` + Playwright pass
- [ ] `SPEC.md` status → `in progress` (during build); then `/agent-skills:review`
