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
| `error-401.json` | `curl -u bad:bad "$U/orders"` |
| `error-404.json` | `curl -u $A "$U/orders/99999"` |
| `error-no-route.json` | `curl -u $A "$U/nope"` |

Things the recordings show that the docs don't: line-item `price` is a JSON number while every other amount is a
string; unset text, weights and dimensions are `""`; variation `image` can be `null`; line `image.src` is `""`.
