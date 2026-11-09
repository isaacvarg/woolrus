import type { LotRuleGroup, LotRules, SetLotRulesInput } from "@woolrus/contracts";
import type { Db, Product, Settings } from "@woolrus/db";
import type { LumexiaClient, LumexiaType } from "../adapters/lumexia/client";
import { isLumexiaError } from "../adapters/lumexia/errors";
import { recordAudit } from "../audit";
import { type Actor, assertCan } from "../permissions";
import { loadSettings } from "../settings/service";
import { lumexiaClientFor } from "./connection";

// Lot rules (SPEC-lumexia "Lot rules and linking", decision 3): admins switch on the Lumexia item,
// procurement and inventory types whose items need a lot. Types are matched by id, never by name.

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

const kinds = [
  { kind: "item", group: "itemTypes", input: "itemTypeIds", column: "lumexiaLotItemTypeIds" },
  {
    kind: "procurement",
    group: "procurementTypes",
    input: "procurementTypeIds",
    column: "lumexiaLotProcurementTypeIds",
  },
  {
    kind: "inventory",
    group: "inventoryTypes",
    input: "inventoryTypeIds",
    column: "lumexiaLotInventoryTypeIds",
  },
] as const;

function savedRules(settings: LotRuleSettings): SetLotRulesInput {
  return {
    itemTypeIds: settings.lumexiaLotItemTypeIds,
    procurementTypeIds: settings.lumexiaLotProcurementTypeIds,
    inventoryTypeIds: settings.lumexiaLotInventoryTypeIds,
  };
}

function joinGroup(types: LumexiaType[], saved: readonly string[]): LotRuleGroup {
  const on = new Set(saved);
  const known = new Set(types.map((t) => t.id));
  return {
    types: types.map(({ id, name, isTracked }) => ({
      id,
      name,
      needsLot: on.has(id),
      ...(isTracked === undefined ? {} : { isTracked }),
    })),
    unknownIds: saved.filter((id) => !known.has(id)),
  };
}

/** Lumexia couldn't be asked: the saved ids, unnamed, and nothing to switch. */
function readOnlyRules(settings: LotRuleSettings, messageKey: string): LotRules {
  const group = (ids: readonly string[]): LotRuleGroup => ({
    types: ids.map((id) => ({ id, name: null, needsLot: true })),
    unknownIds: [],
  });
  return {
    readOnly: true,
    messageKey,
    itemTypes: group(settings.lumexiaLotItemTypeIds),
    procurementTypes: group(settings.lumexiaLotProcurementTypeIds),
    inventoryTypes: group(settings.lumexiaLotInventoryTypeIds),
  };
}

/**
 * Lumexia's three type tables joined with the saved switches, plus switched-on ids Lumexia no
 * longer returns ("Removed in Lumexia"). Unconfigured or unreachable → the saved ids, read-only.
 */
export async function getLotRules(
  db: Db,
  actor: Actor,
  connect: (db: Db) => Promise<LumexiaClient | null> = (d) => lumexiaClientFor(d),
): Promise<LotRules> {
  assertCan(actor, "lumexia.manage");
  const settings = await loadSettings(db);
  const client = await connect(db);
  if (!client) return readOnlyRules(settings, "errors.lumexia.unconfigured");
  try {
    const [item, procurement, inventory] = await Promise.all(
      kinds.map(({ kind }) => client.listTypes(kind)),
    );
    return {
      readOnly: false,
      itemTypes: joinGroup(item ?? [], settings.lumexiaLotItemTypeIds),
      procurementTypes: joinGroup(procurement ?? [], settings.lumexiaLotProcurementTypeIds),
      inventoryTypes: joinGroup(inventory ?? [], settings.lumexiaLotInventoryTypeIds),
    };
  } catch (error) {
    if (isLumexiaError(error)) return readOnlyRules(settings, error.messageKey);
    throw error;
  }
}

/**
 * Replaces the three lists. The ids aren't checked against Lumexia, so this works while it's down.
 * Audited `Settings` / `lumexiaLotRules` with before and after; an unchanged save writes nothing.
 */
export async function setLotRules(
  db: Db,
  actor: Actor,
  input: SetLotRulesInput,
): Promise<SetLotRulesInput> {
  assertCan(actor, "lumexia.manage");
  const after: SetLotRulesInput = {
    itemTypeIds: [...new Set(input.itemTypeIds.map((id) => id.toLowerCase()))],
    procurementTypeIds: [...new Set(input.procurementTypeIds.map((id) => id.toLowerCase()))],
    inventoryTypeIds: [...new Set(input.inventoryTypeIds.map((id) => id.toLowerCase()))],
  };
  return db.$transaction(async (tx) => {
    const row = await loadSettings(tx);
    const before = savedRules(row);
    if (JSON.stringify(before) === JSON.stringify(after)) return before;
    const updated = await tx.settings.update({
      where: { id: row.id },
      data: Object.fromEntries(kinds.map(({ input: key, column }) => [column, after[key]])),
    });
    await recordAudit(tx, actor, {
      entityType: "Settings",
      entityId: String(row.id),
      action: "lumexiaLotRules",
      before,
      after,
    });
    return savedRules(updated);
  });
}
