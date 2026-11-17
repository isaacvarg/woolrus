import type { ActivityCategory, ActivityParams, ActivityTarget } from "@woolrus/contracts";
import type { Prisma } from "@woolrus/db";
import type { SystemActor } from "../../permissions";

/** An audit row as an action's `describe` sees it. */
export type ActivityRow = {
  entityType: string;
  entityId: string;
  action: string;
  before: Prisma.JsonValue;
  after: Prisma.JsonValue;
};

/** What the timeline loaded once for the order, for wording and targets. */
export type DescribeContext = {
  /** Order lines by id: their names. */
  lineName(id: string): string | undefined;
  /** Packages by id, discarded ones included: their box numbers. */
  boxNumber(id: string): number | undefined;
  /** Package items by id: the package and line they belong to. */
  packageItem(id: string): { packageId: string; orderItemId: string } | undefined;
  /** Labels by id. */
  label(id: string): { carrier: string; trackingEnd: string | null } | undefined;
  /** Display names of every user id found under a `…ById` key in the rows' before/after. */
  userName(id: string): string | undefined;
};

export type Described = {
  params?: ActivityParams;
  /** Overrides the target worked out from the row's entity; null for none. */
  target?: ActivityTarget | null;
};

export type ActionSpec = {
  category: ActivityCategory;
  /** Consecutive repeats by one person on one target join into one entry. */
  groups: boolean;
  /** Shown by another entry instead (a move's audit row, by its stage event). */
  hidden?: boolean;
  /** The background actor that writes it, named when the row has no person. */
  system?: SystemActor["system"];
  /** Message parameters, and a target when the entity's own isn't right. */
  describe?: (row: ActivityRow, ctx: DescribeContext) => Described;
};

/** Keeps each category file's keys literal for the registry's type. */
export const defineActions = <const T extends Record<string, ActionSpec>>(actions: T): T => actions;

/** A string field of a JSON object, or null. */
export function field(json: Prisma.JsonValue, key: string): string | number | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const value = (json as Record<string, Prisma.JsonValue>)[key];
  return typeof value === "string" || typeof value === "number" ? value : null;
}
