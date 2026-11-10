import type {
  LinkProductInput,
  LinkProductsInput,
  LinkProductsResult,
  LinkSuggestion,
  LumexiaItemDto,
  LumexiaProducts,
  ProductIdInput,
  ProductLinkResult,
  SearchLumexiaItemsInput,
  SetLotOverrideInput,
} from "@woolrus/contracts";
import type { Db, DbTx, Product } from "@woolrus/db";
import type { LumexiaClient, LumexiaItem } from "../adapters/lumexia/client";
import { isLumexiaError } from "../adapters/lumexia/errors";
import { recordAudit } from "../audit";
import { AppError, notFound } from "../errors";
import { type Actor, assertCan, lumexiaActor } from "../permissions";
import { loadSettings } from "../settings/service";
import { lumexiaClientFor } from "./connection";
import { needsLot } from "./rules";

// Product ↔ Lumexia item links (SPEC-lumexia "Lot rules and linking"). Variations have no link of
// their own: their lines use the parent product's (decision 4), so only products are linked here.
// "Not found in Lumexia" is a linked product whose `lumexiaSyncedAt` is null: the daily refresh
// clears it when Lumexia no longer returns the item, and keeps every other value.

type Connect = (db: Db) => Promise<LumexiaClient | null>;
const defaultConnect: Connect = (d) => lumexiaClientFor(d);

/** At most this many links per `linkProducts` transaction (the contract caps it too). */
export const LINK_BATCH = 200;

/** The configured client, or `errors.lumexia.unconfigured`. */
async function requireClient(db: Db, connect: Connect): Promise<LumexiaClient> {
  const client = await connect(db);
  if (!client) throw new AppError("BAD_REQUEST", "errors.lumexia.unconfigured");
  return client;
}

/** Lumexia's own failures become the AppError their message key names. */
async function askLumexia<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (isLumexiaError(error)) throw new AppError("BAD_REQUEST", error.messageKey);
    throw error;
  }
}

function itemDto(item: LumexiaItem): LumexiaItemDto {
  return {
    id: item.id,
    referenceCode: item.referenceCode,
    name: item.name,
    aliases: item.aliases,
    itemTypeId: item.itemTypeId,
    procurementTypeId: item.procurementTypeId,
    inventoryTypeId: item.inventoryTypeId,
    archived: item.archived,
  };
}

/** The link columns an item sets on a product. */
function linkData(item: LumexiaItem, now: Date) {
  return {
    lumexiaItemId: item.id,
    lumexiaItemRef: item.referenceCode,
    lumexiaItemTypeId: item.itemTypeId,
    lumexiaProcurementTypeId: item.procurementTypeId,
    lumexiaInventoryTypeId: item.inventoryTypeId,
    lumexiaSyncedAt: now,
  };
}

type LinkFields = Pick<
  Product,
  | "lumexiaItemId"
  | "lumexiaItemRef"
  | "lumexiaItemTypeId"
  | "lumexiaProcurementTypeId"
  | "lumexiaInventoryTypeId"
  | "lotOverride"
>;

/** What audit rows record of a link. */
function linkAudit(p: LinkFields) {
  return {
    itemId: p.lumexiaItemId,
    referenceCode: p.lumexiaItemRef,
    itemTypeId: p.lumexiaItemTypeId,
    procurementTypeId: p.lumexiaProcurementTypeId,
    inventoryTypeId: p.lumexiaInventoryTypeId,
    lotOverride: p.lotOverride,
  };
}

function linkResult(p: Pick<Product, "id"> & LinkFields): ProductLinkResult {
  return {
    productId: p.id,
    itemId: p.lumexiaItemId,
    referenceCode: p.lumexiaItemRef,
    lotOverride: p.lotOverride,
  };
}

/** Locks the product row, so two admins changing one link don't interleave their audit rows. */
async function lockProduct(tx: DbTx, productId: string): Promise<Product> {
  const [locked] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM products WHERE id = ${productId}::uuid FOR UPDATE`;
  if (!locked) throw notFound();
  return tx.product.findUniqueOrThrow({ where: { id: productId } });
}

async function writeLink(
  tx: DbTx,
  actor: Actor,
  productId: string,
  item: LumexiaItem,
  now: Date,
): Promise<Product> {
  const before = await lockProduct(tx, productId);
  const after = await tx.product.update({ where: { id: productId }, data: linkData(item, now) });
  await recordAudit(tx, actor, {
    entityType: "Product",
    entityId: productId,
    action: "lumexiaLink",
    before: linkAudit(before),
    after: linkAudit(after),
  });
  return after;
}

/**
 * Every product (not variations) with its link, item type name and whether it needs a lot. Type
 * names come from Lumexia when it answers; otherwise they're null and the rest still shows.
 */
export async function lumexiaProducts(
  db: Db,
  actor: Actor,
  connect: Connect = defaultConnect,
): Promise<LumexiaProducts> {
  assertCan(actor, "lumexia.manage");
  const [products, settings, client] = await Promise.all([
    db.product.findMany({ orderBy: [{ name: "asc" }, { id: "asc" }] }),
    loadSettings(db),
    connect(db),
  ]);
  let typeNames = new Map<string, string>();
  if (client && products.some((p) => p.lumexiaItemId)) {
    try {
      typeNames = new Map((await client.listTypes("item")).map((t) => [t.id, t.name]));
    } catch (error) {
      if (!isLumexiaError(error)) throw error;
    }
  }
  return {
    configured: client !== null,
    products: products.map((p) => ({
      id: p.id,
      name: p.name,
      sku: p.sku,
      physical: p.physical,
      link: p.lumexiaItemId
        ? {
            itemId: p.lumexiaItemId,
            referenceCode: p.lumexiaItemRef,
            itemTypeId: p.lumexiaItemTypeId,
            itemTypeName: p.lumexiaItemTypeId ? (typeNames.get(p.lumexiaItemTypeId) ?? null) : null,
            syncedAt: p.lumexiaSyncedAt,
            notFound: p.lumexiaSyncedAt === null,
          }
        : null,
      lotOverride: p.lotOverride,
      needsLot: needsLot(p, settings),
    })),
  };
}

/** Lumexia's item search (name, reference code or alias contains `q`). */
export async function searchLumexiaItems(
  db: Db,
  actor: Actor,
  input: SearchLumexiaItemsInput,
  connect: Connect = defaultConnect,
): Promise<LumexiaItemDto[]> {
  assertCan(actor, "lumexia.manage");
  const client = await requireClient(db, connect);
  return (await askLumexia(() => client.searchItems(input.q))).map(itemDto);
}

/**
 * WooCommerce sells each production base per pack size, as its Lumexia reference code plus one
 * letter (BASE1812G a gallon, BASE1812P a pail), while Lumexia has one item, BASE1812.
 */
const PACK_SIZED_BASE_SKU = /^(BASE\d+)[A-Z]$/i;
const baseCodeOf = (sku: string) => PACK_SIZED_BASE_SKU.exec(sku)?.[1] ?? null;

/**
 * A Lumexia item for each unlinked product whose SKU equals an item's reference code or one of its
 * aliases, case-insensitively. Aliases include other systems' ids, so each match says which it hit.
 * A pack-sized base SKU that matches nothing falls back to its base's reference code (never an
 * alias). A SKU matching more than one item is left out. Writes nothing.
 */
export async function suggestLinks(
  db: Db,
  actor: Actor,
  connect: Connect = defaultConnect,
): Promise<LinkSuggestion[]> {
  assertCan(actor, "lumexia.manage");
  const client = await requireClient(db, connect);
  const products = (
    await db.product.findMany({
      where: { lumexiaItemId: null, sku: { not: null } },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: { id: true, name: true, sku: true },
    })
  ).flatMap((p) => {
    const sku = p.sku?.trim();
    return sku ? [{ ...p, sku }] : [];
  });
  if (products.length === 0) return [];
  const codes = [
    ...new Set(
      products.flatMap((p) => {
        const base = baseCodeOf(p.sku);
        return base ? [p.sku, base] : [p.sku];
      }),
    ),
  ];
  const items = await askLumexia(() => client.findItems({ referenceCodes: codes }));

  return products.flatMap((p): LinkSuggestion[] => {
    const sku = p.sku.toLowerCase();
    const skuMatches = items.flatMap((item): Match[] => {
      if (item.referenceCode.toLowerCase() === sku)
        return [{ item, matchedOn: "referenceCode", matchedValue: item.referenceCode }];
      const alias = item.aliases.find((a) => a.toLowerCase() === sku);
      return alias === undefined ? [] : [{ item, matchedOn: "alias", matchedValue: alias }];
    });
    const base = baseCodeOf(p.sku)?.toLowerCase();
    const matches =
      skuMatches.length > 0 || !base
        ? skuMatches
        : items
            .filter((item) => item.referenceCode.toLowerCase() === base)
            .map(
              (item): Match => ({
                item,
                matchedOn: "baseCode",
                matchedValue: item.referenceCode,
              }),
            );
    const [only] = matches;
    if (!only || matches.length > 1) return [];
    return [
      {
        productId: p.id,
        productName: p.name,
        sku: p.sku,
        item: itemDto(only.item),
        matchedOn: only.matchedOn,
        matchedValue: only.matchedValue,
      },
    ];
  });
}

type Match = { item: LumexiaItem } & Pick<LinkSuggestion, "matchedOn" | "matchedValue">;

/** Reads the item from Lumexia, then stores its id, reference code and three type ids. Audited. */
export async function linkProduct(
  db: Db,
  actor: Actor,
  input: LinkProductInput,
  connect: Connect = defaultConnect,
): Promise<ProductLinkResult> {
  assertCan(actor, "lumexia.manage");
  const client = await requireClient(db, connect);
  const item = await askLumexia(() => client.getItem(input.itemId));
  if (!item) throw new AppError("NOT_FOUND", "errors.lumexia.itemNotFound");
  const now = new Date();
  return linkResult(
    await db.$transaction((tx) => writeLink(tx, actor, input.productId, item, now)),
  );
}

/**
 * Confirmed Match-by-SKU suggestions: up to 200 links in one transaction, with one `findItems`
 * call. All or nothing: an item Lumexia doesn't return links none of them.
 */
export async function linkProducts(
  db: Db,
  actor: Actor,
  input: LinkProductsInput,
  connect: Connect = defaultConnect,
): Promise<LinkProductsResult> {
  assertCan(actor, "lumexia.manage");
  if (input.links.length > LINK_BATCH) throw new AppError("BAD_REQUEST", "errors.validation");
  const client = await requireClient(db, connect);
  // The last link for a product wins; locking in id order keeps concurrent batches from deadlocking.
  const links = [...new Map(input.links.map((l) => [l.productId, l])).values()].sort((a, b) =>
    a.productId.localeCompare(b.productId),
  );
  const ids = [...new Set(links.map((l) => l.itemId))];
  const items = new Map(
    (await askLumexia(() => client.findItems({ ids }))).map((item) => [item.id, item]),
  );
  if (ids.some((id) => !items.has(id)))
    throw new AppError("NOT_FOUND", "errors.lumexia.itemNotFound");
  const now = new Date();
  await db.$transaction(async (tx) => {
    for (const link of links) {
      await writeLink(tx, actor, link.productId, items.get(link.itemId) as LumexiaItem, now);
    }
  });
  return { linked: links.length };
}

/** Clears the link and the lot override. Lots already captured stay. Audited when it changes. */
export async function unlinkProduct(
  db: Db,
  actor: Actor,
  input: ProductIdInput,
): Promise<ProductLinkResult> {
  assertCan(actor, "lumexia.manage");
  return db.$transaction(async (tx) => {
    const before = await lockProduct(tx, input.productId);
    if (before.lumexiaItemId === null && before.lotOverride === null) return linkResult(before);
    const after = await tx.product.update({
      where: { id: input.productId },
      data: {
        lumexiaItemId: null,
        lumexiaItemRef: null,
        lumexiaItemTypeId: null,
        lumexiaProcurementTypeId: null,
        lumexiaInventoryTypeId: null,
        lumexiaSyncedAt: null,
        lotOverride: null,
      },
    });
    await recordAudit(tx, actor, {
      entityType: "Product",
      entityId: input.productId,
      action: "lumexiaUnlink",
      before: linkAudit(before),
      after: linkAudit(after),
    });
    return linkResult(after);
  });
}

/** Always (true), never (false) or follow the rules (null). Needs a link. Audited when it changes. */
export async function setLotOverride(
  db: Db,
  actor: Actor,
  input: SetLotOverrideInput,
): Promise<ProductLinkResult> {
  assertCan(actor, "lumexia.manage");
  return db.$transaction(async (tx) => {
    const before = await lockProduct(tx, input.productId);
    if (before.lumexiaItemId === null) throw new AppError("CONFLICT", "errors.lumexia.notLinked");
    if (before.lotOverride === input.lotOverride) return linkResult(before);
    const after = await tx.product.update({
      where: { id: input.productId },
      data: { lotOverride: input.lotOverride },
    });
    await recordAudit(tx, actor, {
      entityType: "Product",
      entityId: input.productId,
      action: "lotOverride",
      before: { lotOverride: before.lotOverride },
      after: { lotOverride: after.lotOverride },
    });
    return linkResult(after);
  });
}

export type RefreshLumexiaItemsResult = { checked: number; updated: number; notFound: number };

/**
 * The daily `lumexia.refreshItems` job: re-reads every linked item and updates its reference code
 * and type ids, so an item moved to another type follows the lot rules from the next day. An item
 * Lumexia no longer returns keeps its values and is marked not found (`lumexiaSyncedAt` null).
 * Lumexia's errors are thrown as they are, so pg-boss retries an outage.
 */
export async function refreshLumexiaItems(
  db: Db,
  client: LumexiaClient,
  now: Date = new Date(),
): Promise<RefreshLumexiaItemsResult> {
  const linked = await db.product.findMany({
    where: { lumexiaItemId: { not: null } },
    select: { lumexiaItemId: true },
    distinct: ["lumexiaItemId"],
  });
  const ids = linked.map((p) => p.lumexiaItemId as string);
  const result: RefreshLumexiaItemsResult = { checked: 0, updated: 0, notFound: 0 };
  if (ids.length === 0) return result;
  const items = new Map((await client.findItems({ ids })).map((item) => [item.id, item]));

  for (const id of ids) {
    const item = items.get(id);
    await db.$transaction(async (tx) => {
      // Re-read under lock: an admin may have unlinked or relinked since the list was read.
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM products WHERE lumexia_item_id = ${id} ORDER BY id FOR UPDATE`;
      for (const { id: productId } of rows) {
        result.checked += 1;
        if (!item) {
          result.notFound += 1;
          await tx.product.update({ where: { id: productId }, data: { lumexiaSyncedAt: null } });
          continue;
        }
        const before = await tx.product.findUniqueOrThrow({ where: { id: productId } });
        const after = await tx.product.update({
          where: { id: productId },
          data: linkData(item, now),
        });
        if (JSON.stringify(linkAudit(before)) === JSON.stringify(linkAudit(after))) continue;
        result.updated += 1;
        await recordAudit(tx, lumexiaActor, {
          entityType: "Product",
          entityId: productId,
          action: "lumexiaRefresh",
          before: linkAudit(before),
          after: linkAudit(after),
        });
      }
    });
  }
  return result;
}

/** The `lumexia.refreshItems` job: skipped while Lumexia isn't configured. */
export async function runLumexiaRefreshJob(
  db: Db,
  connect: Connect = defaultConnect,
): Promise<RefreshLumexiaItemsResult | { skipped: "unconfigured" }> {
  const client = await connect(db);
  if (!client) return { skipped: "unconfigured" };
  return refreshLumexiaItems(db, client);
}
