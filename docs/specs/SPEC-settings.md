# Spec: `settings`

**Milestone:** M1 · **Depends on:** — · **Used by:** `store-sync`, `identity`, `carriers`, `lumexia`, `workflow`
(SLA), `packing`/`qa` (QA rule), `operations` (PII retention) · **State:** spec draft

Project-wide commands, structure, code style, testing levels and boundaries are in [`../../SPEC.md`](../../SPEC.md);
this spec only adds what is specific to `settings`.

## Objective

Give admins one place in the app to connect the integrations and tune how the warehouse runs, and give every other
module one typed, safe way to read that configuration.

- **SRS:** FR-SET-05 (integrations and ship-from managed in the UI, secrets encrypted), FR-SHIP-09 (ship-from in
  Settings, single warehouse per decisions.md), FR-SET-06 (as reduced by decisions.md: display preference only),
  NFR-SEC-03 (secrets never reach a client).
- **Users:** Admins edit. Every signed-in user reads the non-sensitive operational values the UI needs (weight
  display, idle-lock minutes, SLA thresholds).
- **Why first:** `store-sync` needs WooCommerce credentials from somewhere safe; later modules need ship-from, the
  ShipStation key, the Lumexia key, the QA rule and the SLA thresholds.

### User stories

1. As an admin, I enter the store URL and the WooCommerce key and secret once. Afterwards I can see that they're
   set (with the last 4 characters), but I can never read them back.
2. As an admin, I set the warehouse's ship-from address, and labels later use it.
3. As an admin, I set the sync interval, the station idle-lock time, the per-stage SLA thresholds, the weight
   display format, the PII retention period and whether QA must be a different person from the packer.
4. As any staff member, I see weights in the format the admin chose, without needing access to the settings page.
5. As a developer, other modules read configuration through one core function, with no environment-variable
   lookups scattered around and no decrypting in routes.

## Scope

**In:**
- Encrypting and decrypting secrets in core.
- A settings service in core: a typed read model, partial update, set/clear secret, and a server-internal read of
  secrets and integration config.
- oRPC contract + router for admin and public reads.
- An admin `/settings` page with two sections, General and Integrations.
- Audit events for every change.
- An `encryption` entry in `/api/health`.

**Out (owned elsewhere):**
- "Test connection" buttons: each adapter module adds one for its own integration (`store-sync`, `carriers`,
  `lumexia`).
- Rescheduling the sync job when the interval changes (`store-sync` reads `syncIntervalMinutes`).
- Boxes UI (`packing`), carriers/services UI (`carriers`), user preferences such as theme and locale (`identity`).
- Key rotation tooling: the ciphertext format is versioned so rotation can be added later.
- Several warehouses.

## Design

### Encryption (`packages/core/src/settings/crypto.ts`)

- AES-256-GCM using Node `crypto`. The key comes from `SETTINGS_ENCRYPTION_KEY`, which must be base64 and decode to
  exactly 32 bytes.
- Stored format: `v1:<iv b64>:<authTag b64>:<ciphertext b64>`, with a random 12-byte IV per value.
- `encryptSecret(plain, key)` and `decryptSecret(stored, key)` are pure functions.
- Decryption fails with a typed error when the input has been tampered with or the key is wrong. It never returns
  garbage.
- If the key is missing or malformed, writing a secret throws `AppError("BAD_REQUEST", "errors.settings.encryptionKeyMissing")`.
  Reading settings still works: secrets show as configured but unreadable, and health reports `encryption: fail`.

### Settings service (`packages/core/src/settings/service.ts`)

| Function | Permission | Returns |
|---|---|---|
| `getSettings(db, actor)` | `settings.manage` | `AdminSettings`: every field except secret values; each secret appears as `{ configured: boolean, hint: string \| null }` (hint = `…` + last 4 chars) |
| `getPublicSettings(db, actor)` | any signed-in user | `PublicSettings`: `weightDisplay`, `stationIdleLockMinutes`, `stageSlaMinutes` |
| `updateSettings(db, actor, patch)` | `settings.manage` | `AdminSettings`. Partial: omitted fields are untouched. Audited with before/after of the changed non-secret fields |
| `setSecret(db, actor, { name, value })` | `settings.manage` | `AdminSettings`. Audited as `secret.set` with the name only, never the value or hint |
| `clearSecret(db, actor, { name })` | `settings.manage` | `AdminSettings`. Audited as `secret.clear` |
| `getIntegrationConfig(db, integration)` | none (server-internal, **not** exposed through the API) | `{ woocommerce: { url, consumerKey, consumerSecret, webhookSecret } \| null, shipstation: … , lumexia: … }`, decrypted |

- Secret names (enum): `wooConsumerKey`, `wooConsumerSecret`, `wooWebhookSecret`, `shipstationApiKey`, `lumexiaApiKey`.
- **Development fallback:** outside `NODE_ENV=production`, `getIntegrationConfig` falls back to env vars (`WOO_URL`,
  `WOO_CONSUMER_KEY`, `WOO_CONSUMER_SECRET`, …) for any value not set in Settings. That keeps the zero-config dev
  stack working. In production the env vars are ignored and Settings is the only source.
- The settings row is created on first read if it's missing (the seed creates it too).

### Validation (contracts)

| Field | Rule |
|---|---|
| `shipFromAddress` | `{ name, company?, phone, email?, address1, address2?, city, state (2 letters), postalCode, country: "US" }`. Phone is required because carriers need it |
| `wooStoreUrl`, `lumexiaBaseUrl` | `https://` URL. `http://` only allowed for `localhost`/`*.localhost` hosts (dev) |
| `syncIntervalMinutes` | integer 1–60 |
| `stationIdleLockMinutes` | integer 1–120 |
| `stageSlaMinutes` | object with optional keys `PENDING`, `PICKING`, `PACKING`, `QA`, `READY`; values are integers 1–10080 |
| `weightDisplay` | `LB_OZ` \| `LB_DECIMAL` |
| `piiRetentionDays` | integer 30–3650, or null (keep forever) |
| `qaMustDifferFromPacker` | boolean |
| secret values | non-empty, trimmed, ≤ 500 chars |

Weight display: a shared `formatWeight(oz, weightDisplay, locale)` in core gives `"2 lb 5 oz"` or `"2.31 lb"`. The
boxes page starts using it, which proves the setting reaches the UI.

### API (oRPC, `packages/contracts/src/settings.ts`)

| Procedure | Route |
|---|---|
| `settings.get` | `GET /settings` |
| `settings.public` | `GET /settings/public` |
| `settings.update` | `PATCH /settings` |
| `settings.setSecret` | `PUT /settings/secrets/{name}` |
| `settings.clearSecret` | `DELETE /settings/secrets/{name}` |

No output schema has a field that can carry a secret value.

### UI (`apps/web/src/app/(app)/settings/`)

- Visible in the nav to users with `settings.manage` only. Anyone else opening `/settings` sees the translated
  forbidden message.
- **General:** ship-from form, sync interval, idle lock, SLA per stage, weight display, PII retention, QA rule.
  It saves with one button and shows field-level errors from message keys.
- **Integrations:** a card per integration (WooCommerce, ShipStation, Lumexia) with the URL field where relevant.
  Each secret shows as "Set (…a1b2)" or "Not set", with Replace and Clear actions. Replacing opens an empty write-only
  field; current values are never pre-filled.
- Built with the React Aria + daisyUI primitives in `components/ui`, and every string is in both catalogs.

### Files expected to change

`packages/core/src/settings/{crypto,service,format}.ts` (+ tests), `packages/core/src/index.ts`,
`packages/contracts/src/settings.ts`, `packages/contracts/src/index.ts`, `apps/web/src/server/router.ts`,
`apps/web/src/app/(app)/settings/**`, `apps/web/src/app/(app)/layout.tsx` (nav), `apps/web/src/app/api/health/route.ts`,
`apps/web/src/app/(app)/boxes/boxes-manager.tsx` (formatWeight), `packages/i18n/src/messages/{en,es}.json`,
`apps/web/e2e/settings.spec.ts`. **No Prisma schema change is expected.** Needing one means asking first.

## Success criteria

1. Encrypt → decrypt round-trips. Changing one byte of the IV, tag or ciphertext, or using another key, fails with a
   typed error.
2. `settings.get` and `settings.update` succeed for an Admin. For Picker, Packer, QA and Shipper they fail with
   `FORBIDDEN` / `errors.forbidden`. `settings.public` succeeds for every role and fails for a signed-out caller.
3. After `setSecret`, the database column holds a `v1:` ciphertext, not the plain value. `settings.get` returns
   `{ configured: true, hint: "…" + last4 }`, and no API response or audit row contains the plain value. A test
   serializes all responses and audit rows from a session and searches them for the secret.
4. `getIntegrationConfig` returns the decrypted values. In production mode, unset values come back null even when
   env vars are present. In development mode, env vars fill unset values.
5. Invalid input (each row of the validation table) is rejected with `BAD_REQUEST` and a field-level message key,
   and nothing is written.
6. `updateSettings` with a partial patch changes only those fields and writes one audit event with before and after
   values for them.
7. Without `SETTINGS_ENCRYPTION_KEY`, `setSecret` fails with `errors.settings.encryptionKeyMissing`,
   `/api/health` reports `encryption: "fail"` and the settings page still loads.
8. E2E (desktop): an admin saves a ship-from address and sets the WooCommerce secret. After a reload the address is
   shown, the secret shows as set with its hint, and the input is empty. A Picker sees no Settings link and gets the
   forbidden message at `/settings`.
9. Switching weight display to `LB_DECIMAL` changes how the boxes page shows max weight.
10. Green: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`, plus the Playwright suite.

## Open questions

1. **Env fallback in production:** the proposal ignores env vars in production so the UI is the single source of
   truth. Is that OK, or do you want env vars to keep working in production too (e.g. for disaster recovery)?
2. **Secret hint:** is showing the last 4 characters acceptable, or should it only show "Set"?
3. **Ship-from country:** restricted to `US` for now. Do you ever ship from outside the US?
