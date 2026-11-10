import { z } from "zod";
import { base, Id } from "./base";

// Lumexia's API (SPEC-lumexia). Nothing here carries the API key or Lumexia's URL.

/** Test connection: health's three states, with the reason when it isn't ok. */
export const LumexiaConnectionResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok") }),
  z.object({ status: z.enum(["unconfigured", "down"]), messageKey: z.string() }),
]);
export type LumexiaConnectionResult = z.infer<typeof LumexiaConnectionResult>;

/** One Lumexia type with its lot-rule switch. `name` is null when Lumexia couldn't be asked. */
export const LotRuleType = z.object({
  id: z.string(),
  name: z.string().nullable(),
  needsLot: z.boolean(),
  /** Inventory types only: Lumexia's own "tracked" flag, a hint that switches nothing. */
  isTracked: z.boolean().optional(),
});
export type LotRuleType = z.infer<typeof LotRuleType>;

/** One of the three groups: Lumexia's types, plus switched-on ids Lumexia no longer returns. */
export const LotRuleGroup = z.object({
  types: z.array(LotRuleType),
  unknownIds: z.array(z.string()),
});
export type LotRuleGroup = z.infer<typeof LotRuleGroup>;

/**
 * Settings → Lumexia → Lot rules (SPEC-lumexia "Lot rules and linking"). When Lumexia can't be
 * asked, `readOnly` is true, `messageKey` says why, and each group lists the saved ids unnamed.
 */
export const LotRules = z.object({
  readOnly: z.boolean(),
  messageKey: z.string().optional(),
  itemTypes: LotRuleGroup,
  procurementTypes: LotRuleGroup,
  inventoryTypes: LotRuleGroup,
});
export type LotRules = z.infer<typeof LotRules>;

// Any 8-4-4-4-12 hex id, as Postgres' uuid stores it: Lumexia's ids aren't checked for a version.
const typeIds = z.array(z.guid()).max(500);

/** The three switched-on lists, each replaced whole. Not checked against Lumexia. */
export const SetLotRulesInput = z.object({
  itemTypeIds: typeIds,
  procurementTypeIds: typeIds,
  inventoryTypeIds: typeIds,
});
export type SetLotRulesInput = z.infer<typeof SetLotRulesInput>;

// Lots captured at Packing (SPEC-lumexia "Capturing lots").

/** Whether Lumexia agrees a lot is the box line's item. Only `WRONG_ITEM` ever blocks (at QA). */
export const LotStatus = z.enum(["UNVERIFIED", "VALID", "NOT_FOUND", "WRONG_ITEM"]);
export type LotStatus = z.infer<typeof LotStatus>;

/** One lot on a box line. The default lot (the earliest) gives and takes units. */
export const LotDto = z.object({
  id: z.string(),
  /** null only for a QR scan Lumexia hasn't resolved yet. */
  lotNumber: z.string().nullable(),
  lumexiaLotId: z.string().nullable(),
  quantity: z.number().int(),
  status: LotStatus,
  isDefault: z.boolean(),
});
export type LotDto = z.infer<typeof LotDto>;

// Lumexia items: product ↔ item links (SPEC-lumexia "Lot rules and linking").

/** A Lumexia item, as search and Match by SKU show it. */
export const LumexiaItemDto = z.object({
  id: z.string(),
  referenceCode: z.string(),
  name: z.string(),
  aliases: z.array(z.string()),
  itemTypeId: z.string().nullable(),
  procurementTypeId: z.string().nullable(),
  inventoryTypeId: z.string().nullable(),
  archived: z.boolean(),
});
export type LumexiaItemDto = z.infer<typeof LumexiaItemDto>;

/** A product's link. `notFound` is set when the daily refresh no longer finds the item. */
export const LumexiaLinkDto = z.object({
  itemId: z.string(),
  referenceCode: z.string().nullable(),
  itemTypeId: z.string().nullable(),
  /** null when Lumexia couldn't be asked for the type names. */
  itemTypeName: z.string().nullable(),
  syncedAt: z.coerce.date().nullable(),
  notFound: z.boolean(),
});
export type LumexiaLinkDto = z.infer<typeof LumexiaLinkDto>;

/** One row of the Lumexia items page: a product (variations use their parent's link). */
export const LumexiaProductRow = z.object({
  id: z.string(),
  name: z.string(),
  sku: z.string().nullable(),
  physical: z.boolean(),
  link: LumexiaLinkDto.nullable(),
  /** null = follow the lot rules. */
  lotOverride: z.boolean().nullable(),
  needsLot: z.boolean(),
});
export type LumexiaProductRow = z.infer<typeof LumexiaProductRow>;

/** `configured` is false when Lumexia's URL or key isn't set: nothing can be linked then. */
export const LumexiaProducts = z.object({
  configured: z.boolean(),
  products: z.array(LumexiaProductRow),
});
export type LumexiaProducts = z.infer<typeof LumexiaProducts>;

export const SearchLumexiaItemsInput = z.object({ q: z.string().trim().min(1).max(100) });
export type SearchLumexiaItemsInput = z.infer<typeof SearchLumexiaItemsInput>;

/** A proposed link: the SKU equals the item's reference code or one of its aliases. */
export const LinkSuggestion = z.object({
  productId: z.string(),
  productName: z.string(),
  sku: z.string(),
  item: LumexiaItemDto,
  matchedOn: z.enum(["referenceCode", "alias"]),
  /** The code or alias as Lumexia has it. */
  matchedValue: z.string(),
});
export type LinkSuggestion = z.infer<typeof LinkSuggestion>;

const lumexiaItemId = z.string().trim().min(1).max(100);

export const LinkProductInput = z.object({ productId: Id, itemId: lumexiaItemId });
export type LinkProductInput = z.infer<typeof LinkProductInput>;

/** Confirmed suggestions, linked in one transaction. */
export const LinkProductsInput = z.object({
  links: z.array(LinkProductInput).min(1).max(200),
});
export type LinkProductsInput = z.infer<typeof LinkProductsInput>;

export const LinkProductsResult = z.object({ linked: z.number().int() });
export type LinkProductsResult = z.infer<typeof LinkProductsResult>;

export const ProductIdInput = z.object({ productId: Id });
export type ProductIdInput = z.infer<typeof ProductIdInput>;

/** true/false = always/never needs a lot; null = follow the lot rules. */
export const SetLotOverrideInput = z.object({
  productId: Id,
  lotOverride: z.boolean().nullable(),
});
export type SetLotOverrideInput = z.infer<typeof SetLotOverrideInput>;

export const ProductLinkResult = z.object({
  productId: z.string(),
  itemId: z.string().nullable(),
  referenceCode: z.string().nullable(),
  lotOverride: z.boolean().nullable(),
});
export type ProductLinkResult = z.infer<typeof ProductLinkResult>;

export const lumexia = {
  testConnection: base
    .route({
      method: "POST",
      path: "/lumexia/test-connection",
      tags: ["Lumexia"],
      summary: "Check the saved Lumexia URL and API key",
    })
    .output(LumexiaConnectionResult),
  lotRules: base
    .route({
      method: "GET",
      path: "/lumexia/lot-rules",
      tags: ["Lumexia"],
      summary: "Lumexia's types with their lot-rule switches",
    })
    .output(LotRules),
  setLotRules: base
    .route({
      method: "PUT",
      path: "/lumexia/lot-rules",
      tags: ["Lumexia"],
      summary: "Replace the Lumexia types whose items need a lot",
    })
    .input(SetLotRulesInput)
    .output(SetLotRulesInput),
  products: base
    .route({
      method: "GET",
      path: "/lumexia/products",
      tags: ["Lumexia"],
      summary: "Products with their Lumexia links and whether they need a lot",
    })
    .output(LumexiaProducts),
  searchItems: base
    .route({
      method: "GET",
      path: "/lumexia/items",
      tags: ["Lumexia"],
      summary: "Search Lumexia items by name, reference code or alias",
    })
    .input(SearchLumexiaItemsInput)
    .output(z.array(LumexiaItemDto)),
  suggestLinks: base
    .route({
      method: "POST",
      path: "/lumexia/suggest-links",
      tags: ["Lumexia"],
      summary: "Propose a Lumexia item for each unlinked product by SKU (writes nothing)",
    })
    .output(z.array(LinkSuggestion)),
  linkProduct: base
    .route({
      method: "POST",
      path: "/lumexia/products/{productId}/link",
      tags: ["Lumexia"],
      summary: "Link a product to a Lumexia item",
    })
    .input(LinkProductInput)
    .output(ProductLinkResult),
  linkProducts: base
    .route({
      method: "POST",
      path: "/lumexia/products/link",
      tags: ["Lumexia"],
      summary: "Link up to 200 products to Lumexia items in one go",
    })
    .input(LinkProductsInput)
    .output(LinkProductsResult),
  unlinkProduct: base
    .route({
      method: "POST",
      path: "/lumexia/products/{productId}/unlink",
      tags: ["Lumexia"],
      summary: "Remove a product's Lumexia link and lot override (captured lots stay)",
    })
    .input(ProductIdInput)
    .output(ProductLinkResult),
  setLotOverride: base
    .route({
      method: "PUT",
      path: "/lumexia/products/{productId}/lot-override",
      tags: ["Lumexia"],
      summary: "Make a linked product always or never need a lot, or follow the rules",
    })
    .input(SetLotOverrideInput)
    .output(ProductLinkResult),
};
