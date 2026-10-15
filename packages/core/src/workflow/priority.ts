import type { PriorityRuleCondition } from "@woolrus/contracts";

/** The order fields priority rules look at. */
export type PriorityOrder = { shippingMethod: string | null; orderedAt: Date };
export type PriorityItem = { sku: string | null; name: string };
export type PriorityRuleInput = {
  condition: PriorityRuleCondition;
  priority: number;
  enabled: boolean;
};

const hourMs = 3_600_000;

function matches(
  condition: PriorityRuleCondition,
  order: PriorityOrder,
  items: readonly PriorityItem[],
  now: Date,
): boolean {
  switch (condition.type) {
    case "lineItem": {
      if (condition.match === "sku") return items.some((item) => item.sku === condition.value);
      const name = condition.value.toLowerCase();
      return items.some((item) => item.name.toLowerCase() === name);
    }
    case "shippingMethod":
      return (
        order.shippingMethod?.toLowerCase().includes(condition.contains.toLowerCase()) ?? false
      );
    case "orderAge":
      return now.getTime() - order.orderedAt.getTime() >= condition.minHours * hourMs;
  }
}

/**
 * An order's priority: the highest `priority` among enabled rules that match it, or 0 (Normal).
 * Rule position doesn't matter; it only orders the admin list.
 */
export function computePriority(
  order: PriorityOrder,
  items: readonly PriorityItem[],
  rules: readonly PriorityRuleInput[],
  now: Date,
): number {
  let priority = 0;
  for (const rule of rules) {
    if (rule.enabled && rule.priority > priority && matches(rule.condition, order, items, now)) {
      priority = rule.priority;
    }
  }
  return priority;
}
