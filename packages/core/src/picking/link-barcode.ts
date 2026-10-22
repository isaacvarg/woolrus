import type { LinkBarcodeInput, LinkBarcodeResult } from "@woolrus/contracts";
import type { Db, DbTx } from "@woolrus/db";
import { recordAudit } from "../audit";
import { AppError, notFound } from "../errors";
import { type Actor, assertCan } from "../permissions";
import { CODE_PADDING, normalizeCode } from "./codes";

// Linking a barcode (SPEC-picking "Code matching", decision 2): an admin puts an unknown scanned code
// on the line's variation, else its product, so the next scan of it matches on every order. Store
// sync leaves a barcode the store doesn't send alone (SPEC-store-sync SC 9).

/** Rows a code must not already belong to: the target itself and, for a variation, its product. */
type Own = { productId: string; variationId: string | null };

/**
 * The product or variation a normalized code is already a barcode or SKU of, variations first.
 * Codes are stored as the store typed them, so both sides compare normalized, as on the lines (the
 * same padding stripped as `normalizeCode`, which a plain SQL `trim` wouldn't).
 */
export async function findCodeOwner(
  tx: DbTx,
  code: string,
  own?: Own,
): Promise<{ name: string } | undefined> {
  const productId = own?.productId ?? null;
  const variationId = own?.variationId ?? null;
  const pad = CODE_PADDING;
  const [found] = await tx.$queryRaw<{ name: string }[]>`
    SELECT name FROM (
      SELECT v.name, 1 AS rank FROM product_variations v
        WHERE (upper(btrim(v.barcode, ${pad})) = ${code} OR upper(btrim(v.sku, ${pad})) = ${code})
          AND v.id IS DISTINCT FROM ${variationId}::uuid
      UNION ALL
      SELECT p.name, 2 AS rank FROM products p
        WHERE (upper(btrim(p.barcode, ${pad})) = ${code} OR upper(btrim(p.sku, ${pad})) = ${code})
          AND p.id IS DISTINCT FROM ${productId}::uuid
    ) AS found ORDER BY rank, name LIMIT 1`;
  return found;
}

/** Sets `code` as the barcode of the line's variation, else its product. Needs `product.manage`. */
export async function linkBarcode(
  db: Db,
  actor: Actor,
  { orderItemId, code }: LinkBarcodeInput,
): Promise<LinkBarcodeResult> {
  assertCan(actor, "product.manage");
  const barcode = code.trim();
  const wanted = normalizeCode(barcode);
  return db.$transaction(async (tx) => {
    // Two admins linking the same code to different products: the second waits, then sees the first.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`barcode:${wanted}`}))`;
    const item = await tx.orderItem.findUnique({
      where: { id: orderItemId },
      select: {
        product: { select: { id: true, name: true, barcode: true } },
        variation: { select: { id: true, name: true, barcode: true } },
      },
    });
    if (!item) throw notFound();
    const { product, variation } = item;
    if (!product) throw new AppError("CONFLICT", "errors.picking.noProductToLink");

    const owner = await findCodeOwner(tx, wanted, {
      productId: product.id,
      variationId: variation?.id ?? null,
    });
    if (owner) {
      throw new AppError("CONFLICT", "errors.picking.codeInUse", undefined, {
        params: { name: owner.name },
      });
    }

    const target = variation
      ? { entityType: "ProductVariation", row: variation }
      : { entityType: "Product", row: product };
    if (variation) {
      await tx.productVariation.update({ where: { id: variation.id }, data: { barcode } });
    } else {
      await tx.product.update({ where: { id: product.id }, data: { barcode } });
    }
    await recordAudit(tx, actor, {
      entityType: target.entityType,
      entityId: target.row.id,
      action: "product.linkBarcode",
      before: { barcode: target.row.barcode },
      after: { barcode },
    });
    return {
      barcode,
      linkedTo: variation ? "variation" : "product",
      name: target.row.name,
    };
  });
}
