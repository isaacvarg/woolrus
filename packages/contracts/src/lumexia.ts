import { z } from "zod";
import { base } from "./base";

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
};
