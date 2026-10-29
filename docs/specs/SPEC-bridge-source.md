# Spec: `bridge-source`

**Milestone:** M4 · **Depends on:** `carriers` (the `ShippingProvider` seam, provider accounts, registry, rate fetch,
`providerContract` suite, fakes) · **Used by:** `qa` (selects and, once booking is on, buys through it), `shipping`
(void, manifests) · **State:** planned

Project-wide commands, structure, code style, testing levels and boundaries are in [`../../SPEC.md`](../../SPEC.md);
this spec only adds what is specific to `bridge-source`. The seam and the facts about Bridge Source's API it was
shaped around are in [SPEC-carriers § Bridge Source fit check](SPEC-carriers.md#bridge-source-fit-check-adapter-built-in-bridge-source);
this spec does not repeat that table, it decides what we build from it and in what order.

## Objective

Add **Bridge Source** as the second `ShippingProvider`, so its rates appear next to ShipStation's on every package in
QA (SPEC-carriers story 3) and the warehouse can see whether they are worth buying.

We will be given **read-only credentials that can only get quotes**. Buying labels comes later, if the rates turn
out to be worth it, and our account's CORE API access (needed to book, void and look up shipments) is **not yet
confirmed**. So the module ships in two stages, and only the first is built now:

- **Stage 1: quote-only (this module's build).** `ping`, `listCarriers`, `getRates`. Bridge Source rates are shown
  and compared, labelled "quote only", and can't be selected or bought.
- **Stage 2: booking (specified here, built later).** `purchaseLabel`, `findLabel`, `voidLabel`, label PDF and cost.
  Gated on CORE access being confirmed and on the sandbox proving the open items below. It is a separate set of
  tickets, created when the gate opens. Nothing in stage 1 may make stage 2 harder.

- **SRS:** none; decisions.md (Shipping providers, 2026-10-27) and SPEC-carriers.
- **Users:** Admins (`settings.manage`) enter the base URL and credentials, test, enable and sync. QA and everyone
  with `order.read` see its rates.

### User stories

1. As an admin, on **Settings → Shipping** I set Bridge Source's base URL, then its API key and customer id, click
   **Test connection**, and switch it on. (Changing the URL's origin later clears the credentials, as in
   SPEC-carriers.)
2. I click **Sync carriers**: the carriers and services in our Bridge Source account appear, disabled, with Domestic /
   International badges. I switch on the ones we use.
3. As QA, the order's rates table now lists Bridge Source quotes beside ShipStation's, each marked **Quote only**.
   The cheapest *buyable* rate is pre-selected; a cheaper Bridge Source quote is visible but not selected.
4. If Bridge Source is slow or down I see "Bridge Source: no rates (timed out)" and the ShipStation rates, as for any
   provider.
5. *(Stage 2)* When booking is switched on for the account, its rates become selectable and QA buys, voids and
   re-prints through it like any other provider.

## Scope

**In (stage 1):**
- `BridgeSourceAdapter` in `packages/core/src/adapters/shipping/bridge-source/` (`adapter.ts`, `schemas.ts`,
  `__fixtures__/`, tests), registered in `shippingAdapters` so the provider can be enabled.
- Mapping Bridge Source's errors to `ShippingError`.
- The `purchase` capability on the seam and its three consequences (below).
- Settings → Shipping: the Bridge Source card loses "Coming soon"; the base-URL field already exists.
- Health: it reports through the existing per-provider `ping` (nothing to add).
- A docs-built-fixtures adapter suite, run through the shared `providerContract`. Live tests and re-recording the
  fixtures from the real API are [#122](https://github.com/isaacvarg/woolrus/issues/122), separate and non-blocking.

**Out / later (stage 2, gated):** booking, label PDF and cost fetch, void, lookup by reference, manifests, the
`bookingEnabled` switch's UI. Manifests (a carrier's end-of-day hand-over document listing the day's labels) are an
adapter method here when booking lands, and the flow around it belongs to `shipping`; `manifests` stays `false`
until then.

**Out always:** address validation (Bridge Source has none; ShipStation validates when enabled), UPS-specific code,
setting `approvePrepayRecharge`, any live label purchase without asking first.

## The seam amendment (`carriers` owns the seam; ask-first, approved with this spec)

A provider that can quote but not buy needs the rest of the app to know it. One small change, no migration:

1. **`ProviderCapabilities.purchase: boolean`** (new). ShipStation `true`; both fakes `true`; Bridge Source `false`
   until booking is on (below). `purchaseLabel` stays required on the interface; a `purchase: false` adapter throws
   `ShippingError("rejected", "bookingDisabled")` if called, as a backstop and never as the normal path.
2. **Rate fetch** (`carriers/rates.ts`): the cheapest-rate pick considers only rates whose provider has `purchase`.
   Quote-only rates are stored and shown but never `selected`. If a package has only quote-only rates, nothing is
   selected and `qa`'s existing "no rate selected" gate applies.
3. **`qa` `selectRate`** refuses a quote-only rate (`errors.qa.rateQuoteOnly`), so it can't be chosen by id. The rate
   rows carry a `quoteOnly` flag in `getOrderShipping` (derived at read time from the provider's capability; no
   column), and the UI shows the badge and disables the select control.

`purchase` is derived from the account, not hard-coded: Bridge Source's is `config.bookingEnabled === true`
(default absent, so `false`). It is set only by stage 2's admin switch; stage 1 never writes it.

## The adapter (`adapters/shipping/bridge-source/`)

`fetch` + Zod schemas, no SDK (like the ShipStation, WooCommerce and Resend adapters). Credentials
`{ apiKey, customerId }` (already in `providerCredentialSchemas`); base URL from the account config, no default
(its host is not in the docs). Every call is `Authorization: RSIS <apiKey>` to
`<baseUrl>/restapi/v1/customers/<customerId>/…`.

**Source-driven:** the endpoint paths and field names below come from the fit check's reading of "API Documentation
(Rest & CORE)" (2026-07-21). That document is not in the repo, so the ticket that builds the adapter **verifies each
against the current docs before writing a schema**, and notes any difference in the fixtures' README. Where the docs
and this spec disagree, the docs win and this spec gets corrected in the same PR.

| Method | Bridge Source | Notes |
|---|---|---|
| `ping` | `GET …/services` (any 2xx) | Cheapest authenticated read-only call. A 2xx with a body that doesn't parse is `unavailable`, not ok. |
| `listCarriers` | `GET …/services` | Group by `carrierCode` (= `externalId`, and `code`); name from the first service's carrier name, else the code. Skip inbound services. `providerData` per service: the custom-packaging `packageTypeCode`, and the supported / unsupported country lists. `domestic` / `international` come from those lists (US in the supported list, any non-US country allowed). A service with no custom-packaging package type is listed but `providerData.packageTypeCode` is absent and it is skipped by `getRates` with a logged reason. |
| `getRates` | `POST …/quote`, one carrier + service + package type per call | One call per requested service, **at most 4 at once**, the whole set inside `PROVIDER_TIMEOUT_MS`. Each quote → one `ProviderRate`: `providerRateId` absent, `amountCents` = `totalAmount` (surcharges included) × 100 rounded, `currency` `USD`, `deliveryDays` / `estimatedDeliveryAt` absent, `guaranteed: false`, `trackable: true`, `expiresAt` absent (the rate fetch applies `RATE_TTL_HOURS`). |
| `purchaseLabel` | *(stage 1)* throws `rejected` / `bookingDisabled` | See stage 2. |
| `validateAddress`, `findLabel`, `voidLabel` | not implemented | Optional methods left off; capabilities `false`. |

**Quote partial failure:** a service Bridge Source refuses for this shipment (422 about the service, country or
package) is dropped from the result and logged; it does not fail the package. The call fails as a whole
(`ShippingError`) only when **every** requested service failed, with the kind of the first failure; this is what lets
the existing partial-failure and retry rules in SPEC-carriers (criterion 9) work unchanged.

**Residential and address:** the quote carries `shipTo` as given; if Bridge Source has a residential flag the adapter
sets it from `RateRequest.residential`. If it has none, that is noted in the fixtures README and in the open
questions.

**Units:** dimensions inches and weight ounces in `RateRequest`; the adapter converts to whatever the API wants
(pounds / ounces split is likely; verify) and money to integer cents, rounding half up, at the boundary and nowhere
else.

**Errors** (`ShippingError`, never leaking the key, customer id, address or Bridge Source's free text into `detail`):

| Condition | Kind |
|---|---|
| 401, 403 | `unauthorized` |
| 422 | `rejected`, `detail` = `errorCategory`; `notOffered` when the category says the service isn't available for the lane, `addressRejected` when it names the address |
| 404 on a service/route, 405, 415 | `rejected` (our bug or a wrong base URL; `detail` = status) |
| 5xx, network failure | `unavailable` |
| 429 (undocumented, handled anyway) | `unavailable` |
| Aborted / over time | `timeout` |

### Stage 2: booking (specified, not built now)

Built only after both gates open: **(a)** Bridge Source confirms our account has CORE API access, **(b)** the
sandbox (or a supervised real shipment, asked first) proves the open items. Then, per the fit check:

- `purchaseLabel`: `POST …/shipments` with the full shipment from `PurchaseInput.shipment`, `labelImageFormat: PDF`,
  our `idempotencyKey` in `shipmentReference2` and the order number in `shipmentReference`; never set
  `approvePrepayRecharge`. `providerLabelId` = `bookNumber`. The adapter then fetches the PDF
  (`GET …/shipments/{bookNumber}/label/PDF`) and the cost (`GET …/shipments/{bookNumber}`, `totalShippingCost`) and
  returns `document: { pdf }`, `costCents`. A refusal for prepaid balance is `rejected` with a `detail` the UI names.
- `findLabel`: `POST …/searchShipments` by keyword for our key. **`labelLookup` stays `false` until the sandbox proves
  that search finds a shipment by `shipmentReference2`**; until then `qa` settles a lost response by hand
  (SPEC-qa step 2).
- `voidLabel`: `POST …/shipments/{bookNumber}` with `{ voided: true }`; `{ ok: true }` → `approved: true`.
- `manifests`: `POST …/manifest` per carrier, base64 PDF. Used by `shipping`.
- Admin switch **Allow buying labels** on the card (write: `settings.manage`, audited, needs a passing test and
  refuses unless the account has been tested since) sets `config.bookingEnabled`, which flips `purchase` to `true`.
  Turning it off again returns the provider to quote-only without losing existing labels.

## Files expected to change

`packages/core/src/adapters/shipping/bridge-source/**` (new), `…/shipping/{provider,registry,fake}.ts`
(`purchase` capability), `packages/core/src/carriers/{rates,queries}.ts` and `packages/core/src/qa/rates.ts`
(quote-only handling), `packages/contracts/src/{carriers,qa}.ts` (`quoteOnly` on rates), the rates table component in
`apps/web/src/app/(app)/` (badge, disabled select), the Bridge Source card on **Settings → Shipping**,
`packages/i18n/src/messages/{en,es}.json`, `.env.example` (nothing new; `BRIDGE_SOURCE_*` live-test vars are
documented in the fixtures README only), `SPEC.md` (status), `docs/specs/SPEC-carriers.md` and `SPEC-qa.md` (the
amendments above), `apps/web/e2e/carriers.spec.ts` (quote-only case). **No schema migration.**

## Success criteria

1. **Seam:** the shared `providerContract` runs against `BridgeSourceAdapter` on its fixtures and passes for 401, 422
   (rejected, notOffered and addressRejected), 5xx, network failure and timeout; cents, ounces, inches and ISO dates
   map correctly.
2. **Mapping:** recorded fixtures for services, a quote, a quote refused by service, and each error status map as
   specified. `listCarriers` groups by `carrierCode`, skips inbound services, extracts the custom-packaging
   `packageTypeCode`, and sets domestic / international from the country lists. No fixture contains a real key,
   customer id, address, or host.
3. **Quote concurrency:** with a fake HTTP layer, a 10-service request makes at most 4 concurrent calls and returns
   within the 20 s budget; one refused service is dropped and the rest return; all refused → a `ShippingError`.
4. **Enable:** with credentials and a passing `ping`, the provider can be enabled (no longer "Coming soon"); a
   failing `ping`, a missing base URL, or missing credentials refuses and changes nothing (existing carriers tests
   keep passing with the real adapter registered).
5. **Quote-only:** with a Bridge-Source-shaped provider at `purchase: false` and ShipStation at `true`, the Bridge
   Source rate is stored and returned with `quoteOnly: true` and is **not** selected even when cheapest; ShipStation's
   cheapest is. With only quote-only rates nothing is selected. `selectRate` on a quote-only rate is refused with
   `errors.qa.rateQuoteOnly` and changes nothing.
6. **Backstop:** calling `purchaseLabel` on the stage 1 adapter throws `rejected` / `bookingDisabled` and makes no HTTP
   request.
7. **Credentials and URL:** the existing serialize-and-search test still finds no key or customer id in responses or
   audit rows; an origin change of the base URL clears the credentials, a path change doesn't (already specified; a
   regression test with the real adapter).
8. **Health:** an enabled Bridge Source whose `ping` fails marks health degraded, not down; the public endpoint still
   reveals only `degraded`.
9. **Permissions:** nothing new is exposed, so no new procedure; the existing forbidden-role tests cover the card.
10. **E2E (desktop + tablet), fakes:** with the Bridge-Source-shaped fake set to quote-only, an admin enables it, QA
    sees its rate marked **Quote only** and unselectable, and the cheapest buyable rate is the selected one.
11. **Live verification** is out of this spec's tickets: it needs the host and read-only credentials, so it is
    tracked separately as [#122](https://github.com/isaacvarg/woolrus/issues/122) and blocks nothing. It never makes a
    booking, void or shipment-creating call.
12. Green: `pnpm lint && pnpm typecheck && pnpm test && pnpm build` plus Playwright.

## Boundaries (this module)

- **Always:** verify field names against Bridge Source's docs before writing a schema; keep credentials write-only;
  cap concurrency at 4; convert units only at the adapter boundary.
- **Ask first:** any call to a real Bridge Source account beyond the read-only live tests; anything that creates,
  books or voids a shipment; turning on `bookingEnabled`; schema changes.
- **Never:** set `approvePrepayRecharge`; log or return the key, customer id, a full address or the provider's free
  text; build stage 2 before its gates open; delete label rows.

## Assumptions

1. The read-only credentials we are given can call `…/services` and `…/quote` and nothing that writes.
2. A Bridge Source quote is good for `RATE_TTL_HOURS` (24); the docs give no expiry.
3. Every go-live order ships domestically from a US origin (carriers' assumption), so the international lists matter
   only for the Domestic / International badge.
4. Several quotes per package (one per enabled service) are cheap enough to make on every rate fetch and refresh.

## Open questions

1. **API host(s):** production and sandbox base URLs. Not in the docs; admin-entered, no default. *Blocks the live
   tests and recording fixtures, not the build.*
2. **`customerId`:** confirm it is the account identifier in the path and not secret.
3. **CORE API access:** to confirm with Bridge Source. *Blocks stage 2 only.*
4. **Residential flag and quote fields:** does `…/quote` take one, and which address / dimension / weight fields are
   required (verify on the docs)? Decides whether `RateRequest.residential` is used.
5. **`shipmentReference2` search:** does `searchShipments` find by it? *Blocks `labelLookup: true`, stage 2.*
6. **Custom-packaging package type:** is it always present per service, and is it right for our boxes? A service
   without one is skipped in stage 1.
7. **Rate parity:** whether quoted `totalAmount` matches `totalShippingCost` after booking (surcharges, reweigh);
   shown to QA as quote vs cost already in `qa`.
8. **When booking is worth it:** the decision to build stage 2 is the user's, after comparing the quotes against
   ShipStation's. This spec only makes that comparison possible.

## Decisions (2026-10-29)

1. **Two stages.** Quote-only first (read-only credentials), booking later behind confirmation of CORE access; one
   module, separate tickets.
2. **Quote-only rates are shown, never selectable.** A `purchase` capability on the seam, derived from the account's
   `bookingEnabled`, so the cheapest pre-selection never lands on something we can't buy. No schema change.
3. **A refused service is dropped, not fatal.** Only a total failure of a provider's quotes fails the provider.
4. **No default host.** The base URL is admin config (already specified by `carriers`).
5. **Manifests are an adapter method that waits for booking;** the end-of-day flow belongs to `shipping`.
