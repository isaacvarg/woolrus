import { type ActivityCategory, activityMessageKey } from "@woolrus/contracts";
import { noteActions } from "./notes";
import { packingActions } from "./packing";
import { pickingActions } from "./picking";
import { problemActions } from "./problems";
import { qaActions } from "./qa";
import { shippingActions } from "./shipping";
import { statusActions } from "./status";
import { storeActions } from "./store";
import type { ActionSpec } from "./types";

export type { ActionSpec, ActivityRow, DescribeContext, Described } from "./types";

/**
 * Every order-scoped action the timeline knows (SPEC-order-activity "Action registry"), one file
 * per category: a module adds or words its actions in its own file, not here. Keys are audit
 * actions, or `<EntityType>.<action>` for bare verbs like a note's `create`.
 */
export const actionRegistry = {
  ...statusActions,
  ...pickingActions,
  ...packingActions,
  ...qaActions,
  ...shippingActions,
  ...problemActions,
  ...noteActions,
  ...storeActions,
} satisfies Record<string, ActionSpec>;

export type ActivityAction = keyof typeof actionRegistry;

const registry: Readonly<Record<string, ActionSpec | undefined>> = actionRegistry;

/** The spec for an audit row's action: `<EntityType>.<action>` first, then the action alone. */
export function actionSpec(entityType: string, action: string): ActionSpec | undefined {
  return registry[`${entityType}.${action}`] ?? registry[action];
}

/** The message the web app words an action with (`activityMessageKey` in contracts). */
export const actionMessageKey = activityMessageKey;

/** Where an action the registry doesn't know is filed, by what it's about. */
const categoryByEntity: Readonly<Record<string, ActivityCategory>> = {
  OrderItem: "picking",
  PickBatch: "picking",
  Package: "packing",
  PackageItem: "packing",
  PackageCheckTrip: "qa",
  Approval: "qa",
  ShippingLabel: "shipping",
  ItemVoid: "problems",
  QualityIssue: "problems",
  Note: "notes",
};

export const categoryForEntity = (entityType: string): ActivityCategory =>
  categoryByEntity[entityType] ?? "status";
