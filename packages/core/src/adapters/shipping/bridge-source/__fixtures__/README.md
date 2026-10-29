# Bridge Source fixtures

Response bodies of the Bridge Source REST API (`<baseUrl>/restapi/v1/customers/<customerId>/…`), written by
hand from SPEC-carriers' "Bridge Source fit check" (itself read from "API Documentation (Rest & CORE)",
2026-07-21). **Not recorded live, and not checked against the docs:** that document is not in the repo and
was not reachable when these were written, so every field name below (`carrierCode`, `carrierName`,
`serviceCode`, `serviceName`, `inbound`, `packageTypes[].packageTypeCode`/`custom`, `supportedCountries`,
`unsupportedCountries`, `errorCategory`) is an assumption to verify. Fixing a name means editing
`schemas.ts` and these files together. [#122](https://github.com/isaacvarg/woolrus/issues/122) re-records
them from the real API with the read-only credentials.

Names, codes and countries are invented; no key, customer id, address or host appears, and
`adapter.test.ts` checks that. The base URL in tests is `https://bridge.test`.

| File | Request |
|---|---|
| `services.json` | `GET …/services` |
| `error-{401,403,422,500}.json`, `error-422-{not-offered,address}.json` | The `{ error, errorCategory }` shape; categories are invented |

Still to confirm on the docs: whether the service list is bare or wrapped (the schema takes both), how the
custom-packaging package type is marked, the `errorCategory` values for "service not offered" and "address".
