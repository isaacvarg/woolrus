import { normalizeCode } from "./codes";

// What's on the shelf (SPEC-picking "Batch list"): the batch pick list groups lines by it, and
// suggested batches count shared products by it, so a card's stops match the batch screen's groups.

export type ShelfLine = {
  variationId: string | null;
  productId: string | null;
  sku: string | null;
  name: string;
};

/** The variation, else the product, else the SKU as a scanner reads it, else the name. */
export function shelfKey(line: ShelfLine): string {
  if (line.variationId) return `variation:${line.variationId}`;
  if (line.productId) return `product:${line.productId}`;
  const sku = normalizeCode(line.sku ?? "");
  return sku ? `sku:${sku}` : `name:${line.name.trim().toLowerCase()}`;
}
