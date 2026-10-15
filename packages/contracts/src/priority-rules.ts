import { z } from "zod";
import { base, Id, IdempotencyKey } from "./base";

/** `Order.priority`: 0 Normal, 1 High, 2 Urgent. */
export const PriorityLevel = z.int().min(0).max(2);
export type PriorityLevel = z.infer<typeof PriorityLevel>;

const RuleText = z.string().trim().min(1).max(200);

/**
 * What a priority rule matches (FR-LIST-04), stored in `PriorityRule.condition`. Evaluated by
 * core's `computePriority`.
 */
export const PriorityRuleCondition = z.discriminatedUnion("type", [
  /** Any line has this SKU (exact) or name (case-insensitive exact), e.g. the Rush Order product. */
  z.object({ type: z.literal("lineItem"), match: z.enum(["sku", "name"]), value: RuleText }),
  /** The shipping method contains this text, ignoring case. */
  z.object({ type: z.literal("shippingMethod"), contains: RuleText }),
  /** The order was placed at least this many hours ago (up to 30 days). */
  z.object({ type: z.literal("orderAge"), minHours: z.int().min(1).max(720) }),
]);
export type PriorityRuleCondition = z.infer<typeof PriorityRuleCondition>;

/** `position` only orders the admin list; an order gets the highest level among its matches. */
export const PriorityRule = z.object({
  id: Id,
  name: z.string(),
  enabled: z.boolean(),
  position: z.int(),
  condition: PriorityRuleCondition,
  priority: PriorityLevel,
});
export type PriorityRule = z.infer<typeof PriorityRule>;

const RuleName = z.string().trim().min(1).max(80);

export const CreatePriorityRuleInput = z.object({
  idempotencyKey: IdempotencyKey,
  name: RuleName,
  condition: PriorityRuleCondition,
  priority: PriorityLevel,
  enabled: z.boolean().default(true),
});
export type CreatePriorityRuleInput = z.infer<typeof CreatePriorityRuleInput>;

export const UpdatePriorityRuleInput = z.object({
  id: Id,
  name: RuleName.optional(),
  condition: PriorityRuleCondition.optional(),
  priority: PriorityLevel.optional(),
  enabled: z.boolean().optional(),
});
export type UpdatePriorityRuleInput = z.infer<typeof UpdatePriorityRuleInput>;

/** Every rule's id in the new order. A list that doesn't match the current rules is a conflict. */
export const ReorderPriorityRulesInput = z.object({
  ids: z
    .array(Id)
    .max(200)
    .refine((ids) => new Set(ids).size === ids.length, { message: "errors.field.invalid" }),
});
export type ReorderPriorityRulesInput = z.infer<typeof ReorderPriorityRulesInput>;

const tags = ["Priority rules"];

// Admin only (settings.manage). Each change recomputes open orders' priority in the same transaction.
export const priorityRules = {
  list: base
    .route({ method: "GET", path: "/priority-rules", tags, summary: "List priority rules" })
    .output(z.array(PriorityRule)),

  create: base
    .route({ method: "POST", path: "/priority-rules", tags, summary: "Create a priority rule" })
    .input(CreatePriorityRuleInput)
    .output(PriorityRule),

  update: base
    .route({
      method: "PATCH",
      path: "/priority-rules/{id}",
      tags,
      summary: "Edit, enable or disable a priority rule",
    })
    .input(UpdatePriorityRuleInput)
    .output(PriorityRule),

  delete: base
    .route({
      method: "DELETE",
      path: "/priority-rules/{id}",
      tags,
      summary: "Delete a priority rule; returns the remaining rules",
    })
    .input(z.object({ id: Id }))
    .output(z.array(PriorityRule)),

  reorder: base
    .route({
      method: "POST",
      path: "/priority-rules/reorder",
      tags,
      summary: "Reorder the priority rules list",
    })
    .input(ReorderPriorityRulesInput)
    .output(z.array(PriorityRule)),
};
