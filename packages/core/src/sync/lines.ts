import type { DbTx, Prisma } from "@woolrus/db";
import type { MappedOrderItem } from "./mapping";

/**
 * Creates order lines, linking each to its product and variation rows (written beforehand, see
 * products-upsert.ts) and bundled lines to their bundle line. A line whose product the store
 * deleted, or never sent, gets no product.
 */
export async function createLines(
  tx: DbTx,
  orderId: string,
  items: MappedOrderItem[],
): Promise<void> {
  if (items.length === 0) return;
  const productIds = await rowIds(
    tx.product.findMany({
      where: { wooProductId: { in: items.flatMap((i) => i.wooProductId ?? []) } },
      select: { id: true, wooProductId: true },
    }),
    (p) => p.wooProductId,
  );
  const variationIds = await rowIds(
    tx.productVariation.findMany({
      where: { wooVariationId: { in: items.flatMap((i) => i.wooVariationId ?? []) } },
      select: { id: true, wooVariationId: true },
    }),
    (v) => v.wooVariationId,
  );

  for (const { wooProductId, wooVariationId, bundleParentWooLineItemId: _, ...line } of items) {
    await tx.orderItem.create({
      data: {
        ...line,
        // Meta values are whatever JSON the store sent.
        metaData: line.metaData as Prisma.InputJsonValue,
        orderId,
        productId: wooProductId === null ? null : (productIds.get(wooProductId) ?? null),
        variationId: wooVariationId === null ? null : (variationIds.get(wooVariationId) ?? null),
      },
    });
  }

  // Bundle parents can come after their children, or already exist (a line added to a bundle), so
  // they're linked once every line is in.
  const bundled = items.filter((i) => i.bundleParentWooLineItemId !== null);
  if (bundled.length === 0) return;
  const lineIds = await rowIds(
    tx.orderItem.findMany({ where: { orderId }, select: { id: true, wooLineItemId: true } }),
    (l) => l.wooLineItemId,
  );
  for (const line of bundled) {
    const parentId = lineIds.get(line.bundleParentWooLineItemId ?? 0);
    if (!parentId) continue;
    await tx.orderItem.update({
      where: { wooLineItemId: line.wooLineItemId },
      data: { bundleParentId: parentId },
    });
  }
}

async function rowIds<T extends { id: string }>(
  rows: Promise<T[]>,
  key: (row: T) => number,
): Promise<Map<number, string>> {
  return new Map((await rows).map((row) => [key(row), row.id]));
}
