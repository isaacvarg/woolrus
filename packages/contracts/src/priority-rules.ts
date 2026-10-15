import { z } from "zod";

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
