import type { ActivityItem, ActivityTarget, OrderActivityFeed } from "@woolrus/contracts";
import type { DbTx, Prisma } from "@woolrus/db";
import { notFound } from "../errors";
import { type Actor, assertCan } from "../permissions";
import { displayName, nameFields } from "../workflow/people";
import { actionSpec, categoryForEntity, type DescribeContext } from "./actions";
import { field } from "./actions/types";
import { cleanDetails } from "./details";
import { groupItems } from "./group";
import { activitySources, type SourceRecord } from "./sources";

/** SPEC-order-activity: a safety net; an order is expected to have well under 1,000 rows. */
export const TIMELINE_ROW_CAP = 2000;

/** Tracking numbers show their last characters only, enough to tell labels apart. */
const TRACKING_END = 6;

/**
 * Everything recorded for one order, newest first (SPEC-order-activity "Timeline"): every source
 * in `activitySources`, worded through the action registry, with repeats grouped.
 */
export async function getOrderActivity(
  db: DbTx,
  actor: Actor,
  { id }: { id: string },
): Promise<OrderActivityFeed> {
  assertCan(actor, "order.read");
  const order = await db.order.findUnique({ where: { id }, select: { id: true } });
  if (!order) throw notFound();

  const take = TIMELINE_ROW_CAP + 1;
  const all = (await Promise.all(activitySources.map((load) => load(db, { orderId: id, take }))))
    .flat()
    .sort((a, b) => b.at.getTime() - a.at.getTime() || (a.id < b.id ? 1 : -1));
  const records = all.slice(0, TIMELINE_ROW_CAP);

  const ctx = await loadContext(db, id, records);
  const items = records.map((record) => toItem(record, ctx));
  const entries = groupItems(
    items,
    (item) => actionSpec(item.entityType, item.action)?.groups ?? false,
  );
  return { entries, truncated: all.length > TIMELINE_ROW_CAP };
}

function toItem(record: SourceRecord, ctx: DescribeContext): ActivityItem {
  const spec = actionSpec(record.entityType, record.action);
  const described = spec?.describe?.(record, ctx) ?? {};
  const target =
    described.target !== undefined
      ? described.target
      : record.target !== undefined
        ? record.target
        : entityTarget(record, ctx);
  return {
    id: record.id,
    at: record.at,
    category: spec?.category ?? categoryForEntity(record.entityType),
    action: record.action,
    entityType: record.entityType,
    actor:
      record.actorId && record.actor
        ? { id: record.actorId, name: displayName(record.actor) }
        : null,
    system: record.actorId ? null : (record.system ?? spec?.system ?? null),
    station: record.station,
    target,
    params: { ...record.params, ...described.params },
    details:
      record.details === false || spec?.details === false
        ? null
        : cleanDetails(record.before, record.after),
  };
}

/** The line, box or label a row is about, from its entity; a deleted box keeps its number. */
function entityTarget(record: SourceRecord, ctx: DescribeContext): ActivityTarget | null {
  const fromRow = (key: string) => field(record.after, key) ?? field(record.before, key);
  const box = (packageId: string | null) => {
    const number = (packageId && ctx.boxNumber(packageId)) ?? fromRow("number");
    return typeof number === "number" ? ({ kind: "box", number } as const) : null;
  };
  switch (record.entityType) {
    case "OrderItem": {
      const name = ctx.lineName(record.entityId) ?? fromRow("name");
      return typeof name === "string" ? { kind: "line", name } : null;
    }
    case "Package":
      return box(record.entityId);
    case "PackageItem": {
      const packageId = ctx.packageItem(record.entityId)?.packageId ?? fromRow("packageId");
      return typeof packageId === "string" ? box(packageId) : null;
    }
    case "ShippingLabel": {
      const label = ctx.label(record.entityId);
      return label ? { kind: "label", ...label } : null;
    }
    default:
      return null;
  }
}

/** Every user id under a `…ById` or `…UserId` key, at any depth. */
function userIds(json: Prisma.JsonValue, into: Set<string>): void {
  if (Array.isArray(json)) for (const v of json) userIds(v, into);
  else if (json && typeof json === "object") {
    for (const [key, value] of Object.entries(json)) {
      if (/(By|User)Id$/.test(key) && typeof value === "string") into.add(value);
      else userIds(value as Prisma.JsonValue, into);
    }
  }
}

async function loadContext(
  db: DbTx,
  orderId: string,
  records: readonly SourceRecord[],
): Promise<DescribeContext> {
  const ids = new Set<string>();
  for (const r of records) {
    userIds(r.before, ids);
    userIds(r.after, ids);
  }
  const ofOrder = { package: { orderId } };
  const [lines, packages, packageItems, labels, users] = await Promise.all([
    db.orderItem.findMany({ where: { orderId }, select: { id: true, name: true } }),
    db.package.findMany({ where: { orderId }, select: { id: true, number: true } }),
    db.packageItem.findMany({
      where: ofOrder,
      select: { id: true, packageId: true, orderItemId: true },
    }),
    db.shippingLabel.findMany({
      where: ofOrder,
      select: { id: true, carrierCode: true, trackingNumber: true },
    }),
    ids.size > 0
      ? db.user.findMany({ where: { id: { in: [...ids] } }, select: { id: true, ...nameFields } })
      : [],
  ]);
  const byId = <T extends { id: string }, V>(rows: T[], value: (row: T) => V) =>
    new Map(rows.map((row) => [row.id, value(row)]));
  const lineNames = byId(lines, (l) => l.name);
  const boxNumbers = byId(packages, (p) => p.number);
  const items = byId(packageItems, ({ packageId, orderItemId }) => ({ packageId, orderItemId }));
  const labelTargets = byId(labels, (l) => ({
    carrier: l.carrierCode,
    trackingEnd: l.trackingNumber ? l.trackingNumber.slice(-TRACKING_END) : null,
  }));
  const names = byId(users, displayName);
  return {
    lineName: (lineId) => lineNames.get(lineId),
    boxNumber: (packageId) => boxNumbers.get(packageId),
    packageItem: (itemId) => items.get(itemId),
    label: (labelId) => labelTargets.get(labelId),
    userName: (userId) => names.get(userId),
  };
}
