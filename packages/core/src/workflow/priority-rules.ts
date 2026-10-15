import {
  type CreatePriorityRuleInput,
  PriorityRuleCondition,
  type PriorityRule as PriorityRuleDto,
  type ReorderPriorityRulesInput,
  type UpdatePriorityRuleInput,
} from "@woolrus/contracts";
import type { Db, DbTx, PriorityRule, WorkflowStatus } from "@woolrus/db";
import { recordAudit } from "../audit";
import { AppError, notFound } from "../errors";
import { withIdempotency } from "../idempotency";
import { type Actor, assertCan } from "../permissions";
import { notifyOrdersChanged, type OrderChangedEvent } from "./notify";
import { computePriority, type PriorityRuleInput } from "./priority";

export type PriorityRuleOptions = { now?: Date };

/** Priority only matters while an order is still on the floor or on hold. */
const closedStatuses: WorkflowStatus[] = ["COMPLETED", "CANCELLED"];

export function toPriorityRuleDto(rule: PriorityRule): PriorityRuleDto {
  return {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    position: rule.position,
    condition: PriorityRuleCondition.parse(rule.condition),
    priority: rule.priority,
  };
}

/**
 * Sets `priority` on open orders (all, or `orderIds`) from the enabled rules, writing only the ones
 * that changed. No version bump: nobody edits priority, so it mustn't make a user's screen stale.
 * Each changed order gets an `order_changed` notify. `store-sync` calls it after an import.
 */
export async function recomputePriorities(
  tx: DbTx,
  { orderIds, now = new Date() }: { orderIds?: readonly string[]; now?: Date } = {},
): Promise<{ updated: number }> {
  const rules: PriorityRuleInput[] = (
    await tx.priorityRule.findMany({ where: { enabled: true } })
  ).map((rule) => ({
    condition: PriorityRuleCondition.parse(rule.condition),
    priority: rule.priority,
    enabled: true,
  }));
  const orders = await tx.order.findMany({
    where: { status: { notIn: closedStatuses }, ...(orderIds && { id: { in: [...orderIds] } }) },
    select: {
      id: true,
      status: true,
      priority: true,
      shippingMethod: true,
      orderedAt: true,
      items: { select: { sku: true, name: true } },
    },
  });

  const byPriority = new Map<number, string[]>();
  const events: OrderChangedEvent[] = [];
  for (const order of orders) {
    const priority = computePriority(order, order.items, rules, now);
    if (priority === order.priority) continue;
    byPriority.set(priority, [...(byPriority.get(priority) ?? []), order.id]);
    events.push({ id: order.id, status: order.status });
  }
  for (const [priority, ids] of byPriority) {
    await tx.order.updateMany({ where: { id: { in: ids } }, data: { priority } });
  }
  await notifyOrdersChanged(tx, events);
  return { updated: events.length };
}

async function listRules(tx: DbTx): Promise<PriorityRuleDto[]> {
  const rules = await tx.priorityRule.findMany({ orderBy: [{ position: "asc" }, { id: "asc" }] });
  return rules.map(toPriorityRuleDto);
}

async function findRule(tx: DbTx, id: string): Promise<PriorityRule> {
  const rule = await tx.priorityRule.findUnique({ where: { id } });
  if (!rule) throw notFound();
  return rule;
}

export async function listPriorityRules(db: DbTx, actor: Actor): Promise<PriorityRuleDto[]> {
  assertCan(actor, "settings.manage");
  return listRules(db);
}

export async function createPriorityRule(
  db: Db,
  actor: Actor,
  input: CreatePriorityRuleInput,
  { now = new Date() }: PriorityRuleOptions = {},
): Promise<PriorityRuleDto> {
  assertCan(actor, "settings.manage");
  const { idempotencyKey, ...data } = input;
  return db.$transaction((tx) =>
    withIdempotency(tx, idempotencyKey, "priorityRules.create", actor, async () => {
      const last = await tx.priorityRule.aggregate({ _max: { position: true } });
      const position = (last._max.position ?? -1) + 1;
      const rule = toPriorityRuleDto(await tx.priorityRule.create({ data: { ...data, position } }));
      await recordAudit(tx, actor, {
        entityType: "PriorityRule",
        entityId: rule.id,
        action: "create",
        after: rule,
      });
      await recomputePriorities(tx, { now });
      return rule;
    }),
  );
}

export async function updatePriorityRule(
  db: Db,
  actor: Actor,
  { id, ...changes }: UpdatePriorityRuleInput,
  { now = new Date() }: PriorityRuleOptions = {},
): Promise<PriorityRuleDto> {
  assertCan(actor, "settings.manage");
  return db.$transaction(async (tx) => {
    const before = toPriorityRuleDto(await findRule(tx, id));
    const rule = toPriorityRuleDto(await tx.priorityRule.update({ where: { id }, data: changes }));
    await recordAudit(tx, actor, {
      entityType: "PriorityRule",
      entityId: id,
      action: "update",
      before,
      after: rule,
    });
    await recomputePriorities(tx, { now });
    return rule;
  });
}

/** Returns the remaining rules. */
export async function deletePriorityRule(
  db: Db,
  actor: Actor,
  { id }: { id: string },
  { now = new Date() }: PriorityRuleOptions = {},
): Promise<PriorityRuleDto[]> {
  assertCan(actor, "settings.manage");
  return db.$transaction(async (tx) => {
    const before = toPriorityRuleDto(await findRule(tx, id));
    await tx.priorityRule.delete({ where: { id } });
    await recordAudit(tx, actor, {
      entityType: "PriorityRule",
      entityId: id,
      action: "delete",
      before,
    });
    await recomputePriorities(tx, { now });
    return listRules(tx);
  });
}

/**
 * `ids` must be exactly the current rules: a rule added or deleted since the admin loaded the list
 * is a conflict, not something to guess at. Position doesn't change priority, so no recompute.
 */
export async function reorderPriorityRules(
  db: Db,
  actor: Actor,
  { ids }: ReorderPriorityRulesInput,
): Promise<PriorityRuleDto[]> {
  assertCan(actor, "settings.manage");
  return db.$transaction(async (tx) => {
    const current = await tx.priorityRule.findMany({ select: { id: true, position: true } });
    const known = new Set(current.map((rule) => rule.id));
    if (ids.length !== known.size || !ids.every((id) => known.has(id))) {
      throw new AppError("CONFLICT", "errors.conflict");
    }
    const positionOf = new Map(current.map((rule) => [rule.id, rule.position]));
    for (const [position, id] of ids.entries()) {
      const before = positionOf.get(id);
      if (before === position) continue;
      await tx.priorityRule.update({ where: { id }, data: { position } });
      await recordAudit(tx, actor, {
        entityType: "PriorityRule",
        entityId: id,
        action: "reorder",
        before: { position: before ?? null },
        after: { position },
      });
    }
    return listRules(tx);
  });
}
