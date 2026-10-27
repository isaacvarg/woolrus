# ShipStation fixtures

Response bodies of ShipStation API v2 (`https://api.shipstation.com`), written by hand from the v2 OpenAPI
reference (<https://docs.shipstation.com/openapi>, spec version 2.0.0, read 2026-10-27): its schemas and its
`POST /v2/rates` example. **Not recorded live:** there is no ShipStation test key yet, and calling a real
ShipStation account is ask-first (SPEC.md boundary). Names, addresses, ids and tracking numbers are invented
(`se-1000001`…, `742 Evergreen Terrace`, `1Z000000000000000`); no key, real address, name or phone appears, and
`adapter.test.ts` checks that.

To re-record with a test key (never buy a label without asking first), with `H="API-Key: $SHIPSTATION_API_KEY"`,
then scrub every name, address, phone, account number and URL token before committing:

| File | Request |
|---|---|
| `carriers.json` | `curl -H "$H" https://api.shipstation.com/v2/carriers` |
| `rates.json`, `rates-error.json` | `curl -H "$H" -H 'Content-Type: application/json' -d @request.json https://api.shipstation.com/v2/rates` |
| `address-{verified,corrected,warning,error}.json` | `curl -H "$H" -H 'Content-Type: application/json' -d '[{…}]' https://api.shipstation.com/v2/addresses/validate` |
| `label.json` | `POST /v2/labels/rates/{rate_id}` (buys a label: ask first) |
| `labels-empty.json` | `curl -H "$H" 'https://api.shipstation.com/v2/labels?external_shipment_id=none'` |
| `void-{approved,declined}.json` | `PUT /v2/labels/{label_id}/void` |
| `error-{400,401,429,500}.json` | The `error_response_body` shape, with codes from the reference's `error_code` enum |

What the reference says that the code relies on: a rate's price is `shipping_amount` + `insurance_amount` +
`confirmation_amount` + `other_amount` (surcharges are in `other_amount`); currencies come lower-case (`usd`);
`external_shipment_id` is cut to 50 characters, so the adapter refuses longer idempotency keys; `GET /v2/carriers`
can answer 207 when some carriers failed, which is still a 2xx; a rate fetch can be a 200 with
`rate_response.status: "error"`.
