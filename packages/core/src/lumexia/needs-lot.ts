import type { Product, Settings } from "@woolrus/db";

// Whether a product needs a lot (SPEC-lumexia "Lot rules and linking", decision 3). Kept free of
// imports beyond types, so the workflow gates can use it without pulling in settings or Lumexia.

export type LotRuleProduct = Pick<
  Product,
  | "physical"
  | "lumexiaItemId"
  | "lumexiaItemTypeId"
  | "lumexiaProcurementTypeId"
  | "lumexiaInventoryTypeId"
  | "lotOverride"
>;

export type LotRuleSettings = Pick<
  Settings,
  "lumexiaLotItemTypeIds" | "lumexiaLotProcurementTypeIds" | "lumexiaLotInventoryTypeIds"
>;

/**
 * A product needs a lot when it is physical, linked to a Lumexia item, and either its override is
 * `true`, or its override is null and any of its three type ids is switched on in the matching list.
 * Pure: callers read the rules live, so a switch changes every product of that type at once.
 */
export function needsLot(product: LotRuleProduct, settings: LotRuleSettings): boolean {
  if (!product.physical || !product.lumexiaItemId) return false;
  if (product.lotOverride !== null) return product.lotOverride;
  const on = (id: string | null, ids: readonly string[]) => id !== null && ids.includes(id);
  return (
    on(product.lumexiaItemTypeId, settings.lumexiaLotItemTypeIds) ||
    on(product.lumexiaProcurementTypeId, settings.lumexiaLotProcurementTypeIds) ||
    on(product.lumexiaInventoryTypeId, settings.lumexiaLotInventoryTypeIds)
  );
}
