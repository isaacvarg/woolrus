# Spec: `carriers`

**Milestone:** M4 · **Depends on:** `settings` (encryption, ship-from, the URL-move rule), `packing` (packages with
box, dimensions and weight; deletes a package's rates when it changes), `workflow` (Packing → QA, the **verified**
gate's `packageNoRate`) · **Used by:** `qa` (rate choice, label purchase through the rate's provider),
`bridge-source` (implements `ShippingProvider`), `shipping` (void, manifests, carrier for the Woo push),
`returns` (return labels), `reporting` (spend by provider, carrier and service) · **State:** planned

Project-wide commands, structure, code style, testing levels and boundaries are in [`../../SPEC.md`](../../SPEC.md);
this spec only adds what is specific to `carriers`.

## Objective

Let the warehouse buy labels from more than one shipping provider. Today that is **ShipStation** (API v2, which also
carries our UPS account) and, next, **Bridge Source**. Admins turn each provider on or off, give it credentials, and
choose which of its carriers and services may be used. When an order finishes packing, every enabled provider is
asked for rates in parallel and QA gets one merged list, cheapest first, tagged by provider. A provider that is down
costs a warning, not a stuck order.

`carriers` owns the seam (`ShippingProvider`), the provider and carrier settings, the rate fetch, address
validation and the ShipStation adapter. It does **not** buy or void labels as a use case; it gives `qa` and
`shipping` an adapter that can.

- **SRS:** FR-SHIP-01…03, FR-SHIP-12, FR-SET-02, FR-PACK-07 (the job `packing` left to us), NFR-REL-03 (rate fetch
  on a durable queue), NFR-OPS-02 (a health entry per provider), the ShipStation half of FR-SET-05. Extends
  FR-SHIP-02 from "enabled carriers" to "enabled providers, then enabled carriers".
- **Users:** Admins (`settings.manage`) configure providers, carriers and services. QA (`order.qa`) refreshes rates
  and re-checks an address. Everyone with `order.read` sees rates and the address check on an order.
- **Why now:** M4 starts here. `qa` can't select a rate or buy a label until rates exist, and the
  **verified** gate already fails every package with `packageNoRate`.

### User stories

1. As an admin, on **Settings → Shipping** I see one card per provider (ShipStation, Bridge Source). I enter
   ShipStation's API key, click **Test connection**, then **Sync carriers**: UPS, USPS and the other carriers
   connected in our ShipStation account appear with their services.
2. I switch on the provider, then the carriers and services we actually use. Each service shows Domestic and/or
   International. Nothing is on until I turn it on.
3. When Bridge Source's adapter lands, I give it credentials and switch it on the same way. Its rates now show
   next to ShipStation's. If I switch it off, new rate fetches skip it; rates already fetched stay until refreshed.
4. As a packer, I complete packing and move on. A few seconds later the order in QA has rates for every package.
5. As QA, I open the order and see per package: the rates from every enabled provider, cheapest pre-selected,
   each with provider, carrier, service, price, delivery estimate and when it expires. If Bridge Source timed out
   I see "Bridge Source: no rates (timed out)" above the ShipStation rates. **Refresh rates** asks again.
6. Above the rates I see the ship-to address. If the provider corrected it ("123 Main **Street** → 123 Main **St**,
   ZIP+4 added"), I see both, and the rates were fetched for the corrected one. **Use original address** re-rates
   with what the customer typed.

## Scope

**In:**
- `ShippingProvider` interface, provider registry and `ShippingError` in `packages/core/src/adapters/shipping/`.
- ShipStation API v2 adapter: ping, list carriers and services, address validation, rates, label purchase, label
  lookup by idempotency key, void, built and tested against recorded fixtures. `qa` and `shipping` call purchase
  and void; this module proves the mapping.
- A fake provider in two shapes for dev, unit tests and Playwright: one like ShipStation (all services in one
  call, rate ids, address validation) and one like Bridge Source (one quote per service, no rate id, books from
  the shipment, no address validation), so the Bridge Source flow is proven before its adapter exists.
- Provider accounts: enable/disable, encrypted credentials, test connection, carrier/service sync and toggles.
- Ship-to resolution (FR-SHIP-03) and address validation (FR-SHIP-12).
- The `rates.fetch` job: enqueued by Packing → QA and by **Refresh rates**; fans out to enabled providers, merges,
  pre-selects the cheapest, stores expiry and per-provider errors.
- Reads: rates per package, the address check, provider status.
- Health entries per provider.
- Schema: provider-neutral columns (below). Approved with this spec.

**Out (owned elsewhere or later):**
- Selecting a rate, buying labels, all-or-nothing purchase, reconciling a `PURCHASING` label: `qa` (FR-QA-02/03/07).
- Voiding labels, repack, manifests (FR-SHIP-14), customs (FR-SHIP-13), tracking push to Woo: `shipping`.
- The Bridge Source adapter: module `bridge-source`, once its docs and sandbox are in hand. This spec fixes the
  interface it implements; if Bridge Source can't fit it, `bridge-source` proposes the change (ask first).
- UPS direct API: not planned. UPS is reached through ShipStation (decided 2026-10-27).
- Several ship-from warehouses (FR-SHIP-09 multi-warehouse): Settings has one ship-from address.
- Currencies other than USD.

## Design

### The seam (`packages/core/src/adapters/shipping/provider.ts`)

```ts
export const providerIds = ["SHIPSTATION", "BRIDGE_SOURCE"] as const;   // Prisma enum ShippingProviderId
export type ProviderId = (typeof providerIds)[number];

/** What a provider can do. Missing capabilities are skipped for that provider, never an error. */
export type ProviderCapabilities = {
  addressValidation: boolean;
  /** Look a label up by our idempotency key, so `qa` can reconcile a purchase whose response was lost. */
  labelLookup: boolean;
  void: boolean;
  manifests: boolean;
};

export interface ShippingProvider {
  readonly id: ProviderId;
  readonly capabilities: ProviderCapabilities;
  /** Succeeds when the credentials are accepted. */
  ping(): Promise<void>;
  listCarriers(): Promise<ProviderCarrier[]>;              // each with its services
  validateAddress?(address: ShipAddress): Promise<AddressCheck>;
  getRates(request: RateRequest): Promise<ProviderRate[]>;
  purchaseLabel(input: PurchaseInput): Promise<PurchasedLabel>;
  findLabel?(idempotencyKey: string): Promise<PurchasedLabel | null>;
  voidLabel?(providerLabelId: string): Promise<{ approved: boolean; message?: string }>;
}
```

The two providers buy labels differently, and the seam has to carry both (checked against Bridge Source's API
docs of 2026-07-21, below):
- ShipStation quotes every service in one call and buys **from a rate id**.
- Bridge Source quotes **one service per call**, returns no rate id, and books **from the full shipment** again.

So a rate never has to have an id, and a purchase always carries the shipment:

- **`ProviderCarrier`:** `{ externalId, name, services: { code, name, domestic, international, providerData }[] }`.
  `providerData` (jsonb on `CarrierService`) is what only the adapter reads, e.g. Bridge Source's custom-packaging
  `packageTypeCode` and its supported countries.
- **`RateRequest`:** `{ orderNumber, shipFrom, shipTo, residential, package: { lengthIn, widthIn, heightIn,
  weightOz }, items: { sku, name, quantity }[], services: { carrierExternalId, code, providerData }[] }`. Only
  enabled carriers and services are sent (FR-SHIP-02). Order number and items let the provider link the shipment
  to the sale (FR-SHIP-01). `residential` comes from the address check when the provider says, else "no company
  name on the ship-to".
- **`ProviderRate`:** `{ providerRateId?, providerShipmentId?, carrierExternalId, serviceCode, serviceName,
  amountCents, currency, deliveryDays?, estimatedDeliveryAt?, guaranteed, trackable, expiresAt? }`.
- **`PurchaseInput`:** `{ rate: { providerRateId?, providerShipmentId?, carrierExternalId, serviceCode,
  providerData }, shipment: RateRequest, idempotencyKey, reference: orderNumber, format: "pdf", size: "4x6" }`.
  `qa` rebuilds `shipment` from the package and `shipTo` at purchase time. They can't have changed since the rate
  was fetched, because `packing` and the address actions delete the rates when they change.
- **`PurchasedLabel`:** `{ providerLabelId, providerShipmentId?, trackingNumber, carrierCode, serviceCode,
  costCents?, currency, document: { url: string } | { pdf: Uint8Array }, shipDate }`. ShipStation gives a URL;
  Bridge Source returns the PDF from a separate call, which its adapter makes. `qa` copies the PDF into our own
  storage either way (`ShippingLabel.storageKey`), so printing never depends on a provider's URL staying up.
- **`AddressCheck`:** `{ status: "verified" | "corrected" | "warning" | "error", address?, residential?,
  messages: string[] }`.
- Money is integer cents, weights ounces, dimensions inches (decisions.md). Adapters convert at the boundary.
- **`ShippingError`**, like `StoreError` and `EmailError`: kinds `unauthorized`, `rejected` (the provider refused
  the request; `detail` holds its error code), `unavailable` (429, 5xx, network), `timeout`. `messageKey` is
  `errors.shipping.<kind>`; `permanent` is false only for `unavailable` and `timeout`. `detail` never contains
  credentials, addresses or the provider's free text.
- **Registry** (`registry.ts`): `createShippingProviders(db): Promise<ShippingProvider[]>` returns one adapter per
  **enabled** provider account with credentials, in fixed order (ShipStation, Bridge Source). Services take the list
  as an argument, so tests pass fakes. When `SHIPPING_PROVIDERS=fake` and `NODE_ENV` is `development` or `test`,
  or `CI=true` (CI's Playwright runs `next start`, where `NODE_ENV` is always `production`), it returns the two fakes
  instead (dev stack and Playwright; there is no ShipStation sandbox in the dev stack). Fails closed otherwise: a
  deploy sets neither.

Each provider gets `PROVIDER_TIMEOUT_MS` (20 s, a constant) for a package's whole `getRates`, however many calls
it makes inside. The adapter doesn't retry by itself; the job does.

### ShipStation adapter (`adapters/shipping/shipstation/`)

`fetch` + Zod schemas, no SDK (like the WooCommerce and Resend adapters). Base URL `https://api.shipstation.com`,
`API-Key` header. Endpoints, to be **verified against ShipStation's current v2 reference** when the ticket is
built (source-driven; record the fixtures from the real API with a test key, then scrub them):

| Method | ShipStation v2 |
|---|---|
| `ping` | `GET /v2/carriers` (any 2xx) |
| `listCarriers` | `GET /v2/carriers` (services included) |
| `validateAddress` | `POST /v2/addresses/validate` |
| `getRates` | `POST /v2/rates` with the shipment inline and `rate_options.carrier_ids` + `service_codes` |
| `purchaseLabel` | `POST /v2/labels/rates/{rate_id}`, `label_format: pdf`, `label_layout: 4x6`, our key as the label's external reference |
| `findLabel` | `GET /v2/labels` filtered by that reference |
| `voidLabel` | `PUT /v2/labels/{label_id}/void`; `approved: false` is returned, not thrown (SRS §7.1 #6) |

Capabilities: all four `true`. UPS appears as one of ShipStation's carriers; nothing in Woolrus is UPS-specific.

### Bridge Source fit check (adapter built in `bridge-source`)

Read from "API Documentation (Rest & CORE)", updated 2026-07-21. The `bridge-source` spec owns the adapter, and
these are the facts this seam was shaped around:

| Need | Bridge Source | Seam consequence |
|---|---|---|
| Auth | `Authorization: RSIS <apiKey>`; every path has `/restapi/v1/customers/{customerId}/` | Credentials `{ apiKey, customerId }`; the base URL is config (not in the docs) |
| Carriers and services | `GET …/services`: a flat list of carrier + service, each with package types and supported or unsupported countries; inbound services listed too | Adapter groups by `carrierCode`, which is the `externalId`; skips inbound; picks the custom-packaging package type into `providerData`; domestic/international from the country lists |
| Rates | `POST …/quote`: one carrier + service + package type per call; `totalAmount` with surcharges; no rate id, no delivery estimate, no expiry | One call per enabled service, at most 4 at once, inside the 20 s budget; `providerRateId` empty; `expiresAt` from `RATE_TTL_HOURS` |
| Buy | `POST …/shipments` (CORE API) with the full shipment, `labelImageFormat: PDF`; returns `bookNumber`, `trackingNumber`; no cost, no label | `providerLabelId` = `bookNumber`; adapter then fetches the PDF (`GET …/shipments/{bookNumber}/label/PDF`) and the cost (`GET …/shipments/{bookNumber}`, `totalShippingCost`) |
| Idempotency | No idempotency key; `shipmentReference` / `shipmentReference2`; `POST …/searchShipments` by keyword covers "shipper reference" | Our key goes in `shipmentReference2`, `findLabel` searches for it. To prove in the sandbox before `labelLookup` is `true` |
| Void | `POST …/shipments/{bookNumber}` `{ voided: true }` → `{ ok: true }` | `void: true` |
| Address validation | None | `addressValidation: false`; ShipStation validates when enabled, else `UNCHECKED` |
| Manifest | `POST …/manifest` per carrier, PDF as base64 | `manifests: true` (used by `shipping`) |
| Errors | 401, 403, 404, 405, 415, 422, 500 with `{ error, errorCategory }`; no 429 documented | 401/403 → `unauthorized`, 422 → `rejected` (`errorCategory` as `detail`), 5xx → `unavailable` |
| Account | Prepaid balance (`prepayBalance`, `approvePrepayRecharge`) | A booking refused for balance is `rejected` and named in the UI; Woolrus never sets `approvePrepayRecharge` |

### Provider accounts and settings (`packages/core/src/carriers/providers.ts`)

| Function | Permission | Rule |
|---|---|---|
| `listProviders` | `settings.manage` | Every known provider id, created on first read if missing: enabled, `credentials: { [field]: { configured } }` (never values), non-secret config, last test result, carrier count, whether its adapter exists in this build. |
| `setProviderCredentials` | `settings.manage` | `{ provider, credentials }` validated by that provider's Zod schema (ShipStation: `{ apiKey }`), encrypted with `encryptSecret` as one JSON blob. Audited `secret.set` with field names only. |
| `clearProviderCredentials` | `settings.manage` | Clears them and **disables** the provider. Audited `secret.clear`. |
| `updateProviderConfig` | `settings.manage` | Non-secret config (Bridge Source will have a base URL). An origin change clears the credentials in the same transaction, as decisions.md 2026-10-15 does for Woo and Lumexia. |
| `testProvider` | `settings.manage` | `ping()`; stores `lastCheckedAt` and `lastErrorKey`; returns ok or the error key. |
| `setProviderEnabled` | `settings.manage` | Enabling requires credentials and a passing `ping()` in the same call (`errors.carriers.providerUnreachable`), and an adapter in this build (`errors.carriers.providerNotAvailable`). Disabling always works. Audited. |
| `syncCarriers` | `settings.manage` | `listCarriers()` → upsert carriers by `(provider, externalId)` and services by `(carrierId, code)`. New ones arrive **disabled**. Ones the provider no longer lists get `missingSince` and stop being sent; they're never deleted (rates, labels and manifests point at them). Audited with counts. |
| `setCarrierEnabled` / `setServiceEnabled` | `settings.manage` | Toggles. A service can be on while its carrier is off; only both on is used. Audited. |

`Settings.shipstationApiKeyEnc` moves to the ShipStation provider account (migration copies the ciphertext; same
key, same `v1:` format) and the column is dropped. `getIntegrationConfig` loses `shipstation`; the settings secret
enum loses `shipstationApiKey`; the ShipStation card leaves **Settings → Integrations** for **Settings → Shipping**.
The dev env fallback stays: `SHIPSTATION_API_KEY` fills an unset key in development and test only.

### Ship-to and address validation (`packages/core/src/carriers/address.ts`)

- **Resolution (FR-SHIP-03, pure):** `resolveShipTo(order)` takes the location (line 1, line 2, city, state, postal
  code, country) from `shippingAddress` as a block, or from `billingAddress` as a block when shipping has none of it,
  so the two are never mixed (decisions 2026-10-27). Name, company, phone and email fall back field by field.
  Missing name, line 1, city, postal code or country → `{ kind: "incomplete", missing }`, and no provider is called.
- **Validation (FR-SHIP-12):** before rating, the first enabled provider with `addressValidation` checks the
  resolved address. Stored on the order: `shipTo` (what rates use), `shipToOriginal` (resolved, unvalidated),
  `shipToStatus` (`UNCHECKED | VERIFIED | CORRECTED | WARNING | ERROR | INCOMPLETE`), `shipToMessages`,
  `shipToCheckedAt`.
  - `verified` → `shipTo` = original. `corrected` → `shipTo` = the provider's address. `warning` → original,
    messages shown. `error` (undeliverable) → original, messages shown; rates are still fetched, and `qa` warns but never
    blocks the purchase (decision 7).
  - No provider can validate, or validation itself fails → `UNCHECKED`, original used, warning shown. It never
    blocks the rate fetch.
- `keepOriginalAddress({ orderId })` (**Use original address**; not `use…`, which Biome takes for a hook) (`order.qa`, order in QA): `shipTo` = original, status `UNCHECKED` with a
  "kept by <user>" note in the audit, then re-rates. `recheckAddress({ orderId })` (`order.qa`) runs validation
  and re-rates.
- A change to the order's addresses from a Woo sync clears `shipTo*` and re-rates if the order is in QA.

### Rate fetch (`packages/core/src/carriers/rates.ts`, job `rates.fetch`)

Payload `{ orderId, generation }`. Enqueued in the transaction that moves an order Packing → QA (a hook in
`workflow`'s `completePacking`, added here) and by `refreshRates({ orderId })` (`order.qa`, order in QA, no live
labels). Each enqueue bumps `Order.rateGeneration`; a job whose generation is no longer current exits, and writes
are checked against it, so a refresh or a repack never gets overwritten by an older job.

1. Resolve and, if needed, validate the ship-to (above). Load ship-from from Settings.
2. Mark every package `ratesStatus = FETCHING`.
3. For each package × each enabled provider, in parallel: send the enabled carriers and services of that provider
   whose Domestic/International flag matches the ship-to country (ship-from is US). A provider with no usable
   carriers is skipped with `noCarriers`.
4. In one transaction per package, if the generation still matches: delete its rates, insert the returned ones
   tagged with provider and carrier, set `expiresAt` = the provider's, else `fetchedAt + RATE_TTL_HOURS` (24, decision 6), drop rates for services not enabled (the provider may return extras), and
   mark the cheapest **selected** (ties: fewer delivery days, then provider order, then service name).
   `rateErrors` = `[{ provider, messageKey }]` for providers that failed; `ratesStatus` = `READY` when at least one
   rate exists, else `FAILED`.
5. `notifyOrderChanged`, so the QA screen updates live.

Retries: a job where every provider failed with a non-permanent error throws and pg-boss retries
(`retryLimit: 2, retryDelay: 20, retryBackoff`). Partial success doesn't retry; QA sees the warning and can refresh.
Rates are never fetched for a package without a weight or box dimensions (the **packed** gate already ensures
both).

`packing` already deletes a package's rates when it changes. It now also sets that package's `ratesStatus = STALE`,
and QA sees **Refresh rates**.

### Reads

- `getOrderShipping({ orderId })` (`order.read`): `shipTo`, original, status, messages, checked-at; per package:
  `ratesStatus`, `rateErrors`, `ratesFetchedAt`, and rates sorted by price with provider name, carrier name,
  service name, amount, delivery estimate, guaranteed, `expiresAt`, `expired`, `selected`. `qa` builds its
  screen on this; `carriers` shows it read-only on the order detail page.
- `listShippingConfig` (`settings.manage`): providers with their carriers and services, for the settings page.

### API (oRPC, `packages/contracts/src/carriers.ts`)

| Procedure | Route |
|---|---|
| `carriers.providers` | `GET /shipping/providers` |
| `carriers.setCredentials` / `clearCredentials` | `PUT` / `DELETE /shipping/providers/{provider}/credentials` |
| `carriers.updateConfig` | `PATCH /shipping/providers/{provider}` |
| `carriers.test` | `POST /shipping/providers/{provider}/test` |
| `carriers.setProviderEnabled` | `POST /shipping/providers/{provider}/enabled` |
| `carriers.sync` | `POST /shipping/providers/{provider}/sync` |
| `carriers.setCarrierEnabled` | `POST /shipping/carriers/{id}/enabled` |
| `carriers.setServiceEnabled` | `POST /shipping/services/{id}/enabled` |
| `carriers.orderShipping` | `GET /orders/{orderId}/shipping` |
| `carriers.refreshRates` | `POST /orders/{orderId}/rates/refresh` |
| `carriers.recheckAddress` / `keepOriginalAddress` | `POST /orders/{orderId}/ship-to/recheck`, `…/use-original` |

No output schema can carry a credential value.

### Schema changes (approved with this spec)

One migration. The tables have no production data (v1 is abandoned; nothing has been bought through V2).

- **New** enum `ShippingProviderId { SHIPSTATION, BRIDGE_SOURCE }` and model `ShippingProviderAccount`
  (`provider` unique, `enabled` default false, `credentialsEnc` nullable, `config` jsonb default `{}`,
  `lastCheckedAt`, `lastErrorKey`, timestamps; `@@map("shipping_provider_accounts")`).
- **`ShippingCarrier`:** `shipstationCarrierId` → `provider` + `externalId`, `@@unique([provider, externalId])`;
  add `missingSince`. `isPrimary` dropped (unused). **`CarrierService`:** add `missingSince`.
- **`CarrierService`** also gains `providerData` jsonb default `{}`.
- **`ShippingRate`:** `shipstationRateId` → `providerRateId`, now nullable; add `provider`, `carrierId` and
  `serviceId` (FKs, Restrict), `providerShipmentId`.
- **`ShippingLabel`:** add `provider`; `shipstationLabelId` → `providerLabelId` with
  `@@unique([provider, providerLabelId])`; `shipstationShipmentId` → `providerShipmentId`; add `storageKey` (our copy of the label PDF, written by `qa`).
- **`Manifest`:** `shipstationManifestId` → `providerManifestId`, unique with the carrier's provider via a
  `provider` column.
- **`Package`:** drop `shipstationShipmentId` (a package rated by two providers has two shipments; it lives on
  the rate). Add `ratesStatus` enum (`NONE | FETCHING | READY | FAILED | STALE`, default `NONE`),
  `ratesFetchedAt`, `rateErrors` jsonb default `[]`.
- **`Order`:** add `shipTo`, `shipToOriginal` (jsonb, nullable), `shipToStatus` enum, `shipToMessages` jsonb
  default `[]`, `shipToCheckedAt`, `rateGeneration Int @default(0)`.
- **`Settings`:** drop `shipstationApiKeyEnc` after copying it into the ShipStation account row.

The init migration's hand-written constraints (one selected rate per package, one live label per package, label
belongs to a package or a return) are kept unchanged.

### Health (`apps/web/src/app/api/health/route.ts`)

One entry per provider: `disabled`, `ok` (a `ping` within the last 5 minutes, cached), `fail`, or
`unconfigured`. An enabled provider failing makes health degraded, not down. The go-live checklist line
"ShipStation green" becomes "every enabled provider green".

### UI (`apps/web/src/app/(app)/`)

- **`settings/shipping`** (Admin; a new tab beside General and Integrations): a card per provider with an
  enable switch, write-only credential fields with Set / Not set, Replace and Clear (the same pattern as
  Integrations), **Test connection** with its result, **Sync carriers** with the last sync time. Under it, a
  table of carriers (switch, name, "no longer offered" badge) with their services (switch, Domestic /
  International badges). A provider without an adapter in this build shows "Coming soon" and can't be enabled.
- **Order detail:** a **Shipping** section showing the ship-to and its check (original vs corrected, with the
  change highlighted by text, not colour alone), and per package the rates table read-only with provider
  errors above it and a **Refresh rates** button for QA. `qa` reuses the same components on its screen.
- All strings in `en` and `es`; the settings page follows the order's and settings' existing toast and error
  patterns.

### Dev data

The fakes return deterministic rates for two fake carriers each ("Demo Ground", "Demo Express"), and the
ShipStation-shaped one returns a corrected address for any address line containing "Street". `pnpm db:seed`
creates both provider accounts (disabled; `.env.example` sets `SHIPPING_PROVIDERS=fake` for dev) and the demo QA
orders get rates from both fakes.

### Files expected to change

`packages/core/src/adapters/shipping/**` (provider, registry, errors, fake, shipstation + fixtures + tests),
`packages/core/src/carriers/{providers,address,rates,queries}.ts` (+ tests), `packages/core/src/workflow/service.ts`
(enqueue on Packing → QA), `packages/core/src/packing/service.ts` (`ratesStatus = STALE`),
`packages/core/src/settings/{service,integration,env}.ts` (ShipStation key moves), `packages/core/src/jobs.ts`,
`packages/core/src/index.ts`, `packages/core/test/factories.ts`, `apps/worker/src/**` (job handler),
`packages/contracts/src/{carriers,settings,index}.ts`, `apps/web/src/server/router.ts`,
`apps/web/src/app/(app)/{settings/**,orders/[id]/**}`, `apps/web/src/app/api/health/route.ts`,
`packages/db/prisma/schema/{shipping,orders,system}.prisma` + one migration, `packages/db/prisma/{seed,seed-orders}.ts`,
`packages/i18n/src/messages/{en,es}.json`, `turbo.json` (`SHIPPING_PROVIDERS`), `.env.example`,
`apps/web/e2e/{carriers,settings}.spec.ts`.

## Success criteria

1. **Seam:** a test suite (`providerContract`) run against both fakes and against the ShipStation adapter on its
   fixtures proves every method maps to the shared types: cents, ounces, inches, ISO dates, `ShippingError` kinds
   for 401, 400, 429, 500, network failure and timeout. `bridge-source` runs the same suite.
2. **ShipStation mapping:** recorded fixtures for carriers, rates, address validation, label purchase, label
   lookup and void (approved and `approved: false`) map correctly; no fixture contains a real key or address.
3. **Credentials:** after `setProviderCredentials` the row holds a `v1:` ciphertext; no response or audit row
   contains the value (serialize-and-search test, as `settings`). Clearing disables the provider. A Bridge Source
   base-URL origin change clears its credentials; a path change doesn't.
4. **Enable:** enabling without credentials, with a failing ping, or for a provider with no adapter is refused and
   changes nothing; with a passing ping it's enabled and audited.
5. **Sync:** new carriers and services arrive disabled; a re-sync keeps toggles; a carrier the provider drops gets
   `missingSince` and is never sent, and its old rates and labels still load.
6. **Ship-to:** the fallback (location as a block, contact fields one by one) is tested as a pure function, including
   that a partial shipping location never borrows from billing; an incomplete address calls no provider and
   leaves `INCOMPLETE` with the missing fields.
7. **Validation:** verified, corrected, warning, error and validation-failure each store the right `shipTo` and
   status; rates are requested for `shipTo`; **Use original address** re-rates with the original.
8. **Fan-out:** with two fake providers, rates from both are stored and tagged; only enabled carriers and services
   matching domestic/international are sent; extras returned by a provider are dropped; the cheapest is the only
   selected rate (ties as specified).
9. **Partial failure:** one provider times out → the other's rates are stored, `rateErrors` names the failed one,
   `READY`, no retry. Both fail transiently → the job throws and is retried; on final failure `FAILED`.
10. **Disabled provider:** a disabled provider is never called; rates it returned earlier stay until a refresh.
11. **Generation:** a slow job finishing after a refresh or a package change writes nothing.
12. **Hook:** completing packing enqueues exactly one `rates.fetch` in the same transaction; a rolled-back
    completion enqueues none. `refreshRates` is refused while any package has a live label.
13. **Health:** each provider reports `disabled`, `unconfigured`, `ok` or `fail` correctly; a failing enabled
    provider marks health degraded.
14. **Permissions:** every procedure has an allowed and a forbidden test (QA can't change providers; a Picker
    can't refresh rates; any role can read an order's shipping).
15. **Performance:** with fake providers at 2 s latency each, a 3-package order × 2 providers has rates stored in
    under 5 s (parallel, not serial); `getOrderShipping` under 300 ms p95 for 5 packages × 30 rates.
16. **E2E (desktop + tablet), fake providers:** an admin enables both fake providers, syncs, enables one carrier
    and one service on each → a packer completes packing → the order detail shows rates from both providers,
    cheapest selected, and the corrected address beside the original → **Use original address** re-rates → the
    admin disables one provider → **Refresh rates** shows only the other's rates. A QA user doesn't see
    **Settings → Shipping**.
17. **Live (opt-in, skipped in CI):** with a ShipStation test key, `ping`, `listCarriers`, `validateAddress` and
    `getRates` succeed. No live label purchase without asking first (SPEC.md boundary).
18. Green: `pnpm lint && pnpm typecheck && pnpm test && pnpm build` plus Playwright.

## Assumptions

1. UPS is used only through ShipStation; any other carrier ShipStation connects (USPS, FedEx…) comes for free.
2. Ship-from is the one Settings address, US only; currency is USD.
3. Rates for a package are all replaced on each fetch; there is no per-provider partial refresh.
4. A provider that fails never blocks QA as long as another returned a rate; QA can always refresh.
5. Address validation corrects automatically, and QA can revert to the original; an `ERROR` address is a warning
   everywhere, never a block.
6. Bridge Source can quote, book, void, look up and manifest labels for ordinary US parcels through its CORE API
   (checked in its docs). Our account has CORE API access; to confirm with Bridge Source.
7. A ship-to with no company name is residential unless the address check says otherwise.

## Decisions (2026-10-27)

1. **Multiple providers:** shipping goes through a `ShippingProvider` seam; each provider is enabled separately and
   only enabled providers are queried.
2. **UPS through ShipStation**, no UPS adapter.
3. **Rates are merged** across providers, cheapest pre-selected; a failing provider is a warning.
4. **Bridge Source is its own module** (`bridge-source`, M4), so its sandbox doesn't gate `qa`.
5. **No v1 cut-over.** v1 was never live; M4's outcome is the first real labels bought in Woolrus.
6. **Rate expiry:** 24 hours (`RATE_TTL_HOURS`) for any provider that doesn't give its own expiry.
7. **Undeliverable address:** a warning in QA, never a block on buying the label.
8. **Purchases carry the shipment, rates needn't carry an id:** Bridge Source quotes per service and books from
   the shipment, so the seam doesn't assume ShipStation's rate-id flow.
9. **Label PDFs are copied into our storage** for every provider, so printing doesn't depend on provider URLs.

## Open questions

1. **Bridge Source host and sandbox:** the docs don't give the base URL, or say whether a sandbox account is
   separate from production. Needed before the `bridge-source` adapter is built, not for this spec.
2. **Bridge Source label lookup:** whether `searchShipments` finds a shipment by `shipmentReference2`. Proven in
   the sandbox; until then its `labelLookup` capability is `false`, and `qa` treats a lost booking response as
   "check Webship by hand".
