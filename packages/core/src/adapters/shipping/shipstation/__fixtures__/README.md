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
| `manifest-created.json`, `manifest-in-progress.json` | `POST /v2/manifests` with `{carrier_id, ship_date, label_ids}` (ask first: it files a real SCAN form) |
| `manifests-list.json`, `manifests-empty.json` | `curl -H "$H" 'https://api.shipstation.com/v2/manifests?carrier_id=…&ship_date_start=…&ship_date_end=…'` |
| `error-manifest-carrier.json` | `POST /v2/manifests` for a carrier without manifests (`carrier_not_supported`) |
| `error-{400,401,429,500}.json` | The `error_response_body` shape, with codes from the reference's `error_code` enum |

What the reference says that the code relies on: a rate's price is `shipping_amount` + `insurance_amount` +
`confirmation_amount` + `other_amount` (surcharges are in `other_amount`); currencies come lower-case (`usd`);
`external_shipment_id` is cut to 50 characters, so the adapter refuses longer idempotency keys; `GET /v2/carriers`
can answer 207 when some carriers failed, which is still a 2xx; a rate fetch can be a 200 with
`rate_response.status: "error"`.

Manifests (read 2026-11-02, `POST /v2/manifests` and `GET /v2/manifests`): the create reference lists only its
response (`manifests[]`, `status: in_progress | completed`, each with `manifest_id`, `label_ids`, `carrier_id`,
`manifest_download.href`); the request body isn't rendered in the published page, so the adapter sends the
documented v1 fields `carrier_id`, `ship_date` and `label_ids` (explicit manifest). The list filters by
`carrier_id`, `ship_date_start` and `ship_date_end`. An `in_progress` answer has no document yet, so the adapter
fails it as `unavailable`: the caller looks the manifest up before trying again. Confirm the request body against
the live API before the first real manifest.
