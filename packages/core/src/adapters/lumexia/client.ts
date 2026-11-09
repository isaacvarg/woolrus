import type { LumexiaItem, LumexiaLot, LumexiaType } from "./schemas";

export type { LumexiaItem, LumexiaLot, LumexiaType } from "./schemas";

export const lumexiaTypeKinds = ["item", "procurement", "inventory"] as const;
export type LumexiaTypeKind = (typeof lumexiaTypeKinds)[number];

/** Reference codes match an item's code or any alias, case-insensitively; ids match exactly. */
export type LumexiaItemFilter = { referenceCodes: string[] } | { ids: string[] };

/**
 * Everything Woolrus reads from Lumexia (docs/lumexia-api.md). Every method throws
 * `LumexiaUnavailable` (retry later), `LumexiaAuthError` (fix the key) or `LumexiaBadResponse`
 * (not Lumexia's API). Services take one: `lumexiaClientFor(db)` for the real one, the fake in tests.
 */
export interface LumexiaClient {
  /** Succeeds when the URL is Lumexia's API v1 and the key can read. */
  ping(): Promise<void>;
  /** Every row of one type table, all pages. */
  listTypes(kind: LumexiaTypeKind): Promise<LumexiaType[]>;
  /** Name, reference code or alias contains `q` (case-insensitive); one page of up to `limit` (50, max 200). */
  searchItems(q: string, limit?: number): Promise<LumexiaItem[]>;
  /** Every matching item, in batches of 200 values, each item once. Unknown values are just missing. */
  findItems(filter: LumexiaItemFilter): Promise<LumexiaItem[]>;
  /** null when Lumexia has no such item. */
  getItem(id: string): Promise<LumexiaItem | null>;
  /** By the UUID a lot label's QR code holds; null when Lumexia has no such lot. */
  getLot(id: string): Promise<LumexiaLot | null>;
  /** Every lot with this number (case-insensitive), on any item: one number can exist on several. */
  findLotsByNumber(lotNumber: string): Promise<LumexiaLot[]>;
}
