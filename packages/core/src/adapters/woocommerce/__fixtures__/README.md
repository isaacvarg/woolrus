# WooCommerce fixtures

Recorded from the dev store (`pnpm stack:up`, `http://localhost:8090`, the dev key in `.env.example`) on
2026-10-15, pretty-printed and otherwise unedited. To re-record, with `U=http://localhost:8090/wp-json/wc/v3` and
`A=ck_woolrus_dev_key:cs_woolrus_dev_secret`:

| File | Request |
|---|---|
| `orders.json` | `curl -u $A "$U/orders?per_page=100&dates_are_gmt=true"` |
| `products.json` | `curl -u $A "$U/products?per_page=100"` |
| `variations-12.json` | `curl -u $A "$U/products/12/variations?per_page=100"` |
| `setting-{weight,dimension}-unit.json` | `curl -u $A "$U/settings/products/woocommerce_{weight,dimension}_unit"` |
| `order-note-created.json` | `curl -u $A -X POST -H content-type:application/json -d '{"note":"Fixture note","customer_note":true}' "$U/orders/17/notes"` (then delete the note) |
| `order-notes.json` | `curl -u $A "$U/orders/17/notes?per_page=100"` |
| `error-401.json` | `curl -u bad:bad "$U/orders"` |
| `error-404.json` | `curl -u $A "$U/orders/99999"` |
| `error-no-route.json` | `curl -u $A "$U/nope"` |

Things the recordings show that the docs don't: line-item `price` is a JSON number while every other amount is a
string; unset text, weights and dimensions are `""`; variation `image` can be `null`; line `image.src` is `""`.

## Advanced Shipment Tracking (AST 4.0.5, free)

Recorded on 2026-11-02 from the dev store with the plugin installed by `docker/wordpress/setup.sh` (it also loads
AST's carrier list; without it a known provider comes back as `""`). `T=$U/../wc-shipment-tracking/v3`:

| File | Request |
|---|---|
| `shipment-tracking-index.json` | `curl -u $A $T` |
| `shipment-tracking-created.json` | `curl -u $A -X POST -H content-type:application/json -d '{"tracking_provider":"USPS","tracking_number":"9400111899223344556677","date_shipped":"2026-11-02"}' $T/orders/17/shipment-trackings` (then DELETE it) |
| `shipment-tracking-created-custom.json` | same with `{"custom_tracking_provider":"Acme Freight","custom_tracking_link":"https://acme.test/track/AF123","tracking_number":"AF123",…}` |
| `shipment-trackings.json` | `curl -u $A $T/orders/17/shipment-trackings` with both items above in place |
| `shipment-trackings-no-order.json` | `curl -u $A $T/orders/99999/shipment-trackings` |
| `shipment-tracking-rejected.json` | POST without `tracking_number` (400) |

What the recordings show that the docs don't: a custom provider is read back with `tracking_provider: ""` (the link
stays), so a retry matches items by tracking number; the provider list endpoint stays `[]`; a store without the
plugin answers WordPress's `rest_no_route` 404 (`error-no-route.json`).
