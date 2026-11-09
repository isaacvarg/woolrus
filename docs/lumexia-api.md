# Lumexia REST API v1 (as built)

The read-only API Woolrus calls, built in the Lumexia repo for module `lumexia` (`docs/specs/SPEC-lumexia.md`).
This file is the contract Woolrus' adapter, schemas and fixtures follow; when Lumexia changes the API, update it
here first.

## Basics

- **Base:** `<lumexia origin>/api/v1`. Lumexia's dev server defaults to :3000, which Woolrus web uses, so run it
  on another port in dev (e.g. `http://localhost:3100`).
- **Auth:** `Authorization: Bearer lmx_…`, a per-user key created in Lumexia under **Settings → User → Agents**.
  A read-only key is enough for every route.
- **JSON only** (`application/json; charset=utf-8`), camelCase, UUID string ids (opaque: never parse them),
  ISO 8601 UTC timestamps. Absent values are `null`, never omitted.
- **Lists:** `{ "<things>": [...], "nextCursor": string | null }`, with `limit` (1–200, default 50) and `cursor`
  (opaque, from `nextCursor`). Stable order by id. Archived records are included with `"archived": true`;
  `include_archived=false` hides them.

## Errors

`{ "error": { "code": "...", "message": "..." } }`

| Status | Code | When |
|---|---|---|
| 400 | `invalid_request` | Bad `limit`, `cursor`, timestamp or boolean, or more than 200 repeated values |
| 401 | `unauthorized` | Missing, unknown, revoked or expired key |
| 403 | `forbidden` | Valid key without read scope |
| 404 | `not_found` | Single-record routes only |
| 500 | `internal` | Unexpected failure |

429 isn't implemented. Woolrus treats 429 and 5xx as retry-later anyway. A list that finds nothing is 200 with
an empty array.

## Routes

| Route | Returns |
|---|---|
| `GET /health` | `{ "ok": true, "apiVersion": "1", "key": { "userId": "…", "scopes": ["read"] } }` |
| `GET /item-types` | `{ "itemTypes": [{ "id", "name", "archived" }], "nextCursor" }` |
| `GET /procurement-types` | Same shape, under `procurementTypes` |
| `GET /inventory-types` | Same shape, under `inventoryTypes`, plus `"isTracked": boolean` per row |
| `GET /items` | `{ "items": [Item], "nextCursor" }` |
| `GET /items/{id}` | One `Item`, or 404 |
| `GET /lots` | `{ "lots": [Lot], "nextCursor" }` |
| `GET /lots/{id}` | One `Lot` by UUID (what the label QR code holds), or 404 |

The three type lists are database tables with UUID ids. None has an archived state, so `archived` is always
false on them.

### Item

```json
{
  "id": "…", "referenceCode": "BASE1234", "name": "Lavender base, 1 gal",
  "aliases": ["LAV-BASE-1G"],
  "itemTypeId": "…", "procurementTypeId": "…", "inventoryTypeId": "…",
  "archived": false, "updatedAt": "2026-11-09T14:03:00.000Z"
}
```

- The three type ids are required in Lumexia, so non-null in practice, but the type allows `null`.
- `aliases` are the alias values across all alias types, sorted and deduplicated. Some are other systems' ids,
  such as WooCommerce product ids.
- `updatedAt` is the later of the item's own change time and its latest alias change.

`GET /items` filters, all optional, combined with AND:
- `q`: case-insensitive contains on name, reference code or alias.
- `reference_code`: exact, case-insensitive, repeatable up to 200; also matches aliases.
- `id`: repeatable up to 200.
- `updated_since`: ISO timestamp; items whose own or alias change is later. A removed alias doesn't show up.
- `include_archived`: `true` (default) or `false`.

### Lot

```json
{ "id": "…", "itemId": "…", "lotNumber": "BASE1234.A12A0124", "archived": false, "createdAt": "2024-01-01T09:00:00.000Z" }
```

- `archived` is always false: lots have no status. An archived item's lots still appear.
- No quantities, units, supplier lot numbers, expiry or receipt data in v1.

`GET /lots` filters: `lot_number` (exact, case-insensitive, our number only; a list, because one number can exist
on several items) and optional `item_id`.

## Lot number format

```
<item referenceCode>.<letter><2 digits><month letter A–L><DD><YY>    e.g. BASE1234.A12A0124
```

The part before the dot is the item's `referenceCode`. Month letters run A = January to L = December. The letter
and two digits are random. The date part is the lot's creation date (2024-01-01 in the example).

## Not exposed in v1

Item record status (a table: active/inactive/archived), inventory unit of measure (a table), and `isSold`
(boolean: sold to customers as-is).
