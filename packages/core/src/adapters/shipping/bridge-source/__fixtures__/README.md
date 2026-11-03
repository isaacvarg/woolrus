# Bridge Source fixtures

Response bodies of the Bridge Source REST API (`<baseUrl>/restapi/v1/customers/<customerId>/…`).
`services.json` has the shape of the live `GET …/services` (checked 2026-11-03 against the real API): the list
is wrapped in `services`, names are `carrierLabel` and `serviceLabel`, and a package type has no "custom" flag:
the shipper's own box is the one whose `packageTypeCode` ends in `_custom_package` ("Your Packaging"). Its
carriers and codes are still invented. The error bodies are written by hand from SPEC-carriers' "Bridge Source
fit check" and **not yet checked**: their `errorCategory` values are assumptions.
[#122](https://github.com/isaacvarg/woolrus/issues/122) re-records the rest from the real API with the
read-only credentials. Fixing a name means editing `schemas.ts` and these files together.

Names, codes and countries are invented; no key, customer id, address or host appears, and
`adapter.test.ts` checks that. The base URL in tests is `https://bridge.test`.

| File | Request |
|---|---|
| `services.json` | `GET …/services` |
| `error-{401,403,422,500}.json`, `error-422-{not-offered,address}.json` | The `{ error, errorCategory }` shape; categories are invented |

The quote request and response were checked live the same day (see SPEC-bridge-source "Live quote shape").
Still to confirm: the `errorCategory` values for "service not offered" and "address".
