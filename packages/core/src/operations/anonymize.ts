import { type Db, type DbTx, Prisma, type ReturnStatus } from "@woolrus/db";
import { isPiiKey } from "@woolrus/logger";
import { recordAudit } from "../audit";
import { operationsActor } from "../permissions";
import { lockWooOrder } from "../sync/order-lock";

// PII anonymization (SPEC-operations "PII anonymization", NFR-SEC-06). Finished orders older than
// `Settings.piiRetentionDays` lose the customer's identity but stay usable for metrics.

export const PII_BATCH_SIZE = 200;
/** One order's transaction: its audit history is rewritten row by row, which can pass Prisma's 5 s default. */
const ORDER_TX_TIMEOUT_MS = 60_000;
/** Idempotency records exist for replays within minutes; they hold response DTOs with customer data. */
export const IDEMPOTENCY_KEEP_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const REDACTED = "[redacted]";
/** A return in any other status is still open. */
const OPEN_RETURN = { notIn: ["CLOSED", "REJECTED"] satisfies ReturnStatus[] };

export type PurgeResult = {
  orders: number;
  webhooks: number;
  idempotency: number;
  /** Orders whose anonymization threw; the next run tries them again. */
  failed: number;
};

/** Orders past the period that anonymization may touch: finished, not yet redacted, no open return. */
function eligible(cutoff: Date): Prisma.OrderWhereInput {
  return {
    piiRedactedAt: null,
    returns: { none: { status: OPEN_RETURN } },
    OR: [
      { status: "COMPLETED", completedAt: { lt: cutoff } },
      { status: "CANCELLED", statusChangedAt: { lt: cutoff } },
    ],
  };
}

/**
 * The daily run: anonymizes eligible orders (batches of 200, one transaction per order, so a failure
 * leaves the others done), redacts old processed webhook payloads, and deletes old idempotency
 * records. A null period anonymizes and redacts nothing; the idempotency cleanup runs regardless.
 * `dryRun` only counts. Logs nothing itself: the caller reports the counts.
 */
export async function purgePii(
  db: Db,
  { now = new Date(), dryRun = false }: { now?: Date; dryRun?: boolean } = {},
): Promise<PurgeResult> {
  const settings = await db.settings.findUnique({
    where: { id: 1 },
    select: { piiRetentionDays: true },
  });
  const days = settings?.piiRetentionDays ?? null;
  const idempotencyCutoff = new Date(now.getTime() - IDEMPOTENCY_KEEP_DAYS * DAY_MS);
  const result: PurgeResult = { orders: 0, webhooks: 0, idempotency: 0, failed: 0 };

  if (days !== null) {
    const cutoff = new Date(now.getTime() - days * DAY_MS);
    // A delivery that never got processed still holds the order's personal data, so it ages out by
    // the time it arrived.
    const webhooks = {
      OR: [{ processedAt: { lt: cutoff } }, { processedAt: null, receivedAt: { lt: cutoff } }],
      NOT: { payload: { equals: { redacted: true } } },
    };
    if (dryRun) {
      result.orders = await db.order.count({ where: eligible(cutoff) });
      result.webhooks = await db.inboundWebhook.count({ where: webhooks });
    } else {
      // Anonymized orders leave `eligible`, so the loop ends; an order that fails stays eligible and is
      // skipped for the rest of this run instead of being re-picked first every batch.
      const failed = new Set<string>();
      for (;;) {
        const batch = await db.order.findMany({
          where: { AND: [eligible(cutoff), { id: { notIn: [...failed] } }] },
          select: { id: true },
          orderBy: { id: "asc" },
          take: PII_BATCH_SIZE,
        });
        if (batch.length === 0) break;
        let done = 0;
        for (const { id } of batch) {
          try {
            if (
              await db.$transaction((tx) => anonymizeOrder(tx, id, now, cutoff), {
                timeout: ORDER_TX_TIMEOUT_MS,
              })
            )
              done += 1;
          } catch {
            failed.add(id);
          }
        }
        result.orders += done;
        // Nothing in a batch changed (all done by another run, or all failed): stop.
        if (done === 0) break;
      }
      result.failed = failed.size;
      result.webhooks = (
        await db.inboundWebhook.updateMany({
          where: webhooks,
          data: { payload: { redacted: true } },
        })
      ).count;
    }
  }

  const old = { createdAt: { lt: idempotencyCutoff } };
  result.idempotency = dryRun
    ? await db.idempotentRequest.count({ where: old })
    : (await db.idempotentRequest.deleteMany({ where: old })).count;
  return result;
}

/** What survives of an address: where it is, not who is there. Keeps the key names it was stored with. */
function reduceAddress(value: Prisma.JsonValue | null): Prisma.InputJsonValue | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const out: Record<string, Prisma.JsonValue> = {};
  for (const key of ["state", "postcode", "postalCode", "country"]) {
    const kept = value[key];
    if (kept !== undefined) out[key] = kept;
  }
  return out;
}

/** `value` with the values of PII keys, at any depth, replaced. Other keys are kept as they were. */
export function scrubPii(value: Prisma.JsonValue): Prisma.JsonValue {
  if (Array.isArray(value)) return value.map(scrubPii);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [
      key,
      isPiiKey(key) ? REDACTED : inner === undefined ? inner : scrubPii(inner),
    ]),
  ) as Prisma.JsonObject;
}

/** The slice of the raw WooCommerce payload that stays: no names, addresses or line meta. */
function keptPayload(raw: Prisma.JsonValue): Prisma.InputJsonObject {
  const payload = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {};
  const out: Record<string, Prisma.JsonValue> = {};
  for (const key of [
    "id",
    "number",
    "status",
    "currency",
    "total",
    "date_created",
    "date_modified",
  ]) {
    const kept = payload[key];
    if (kept !== undefined) out[key] = kept;
  }
  return { ...out, redacted: true };
}

/**
 * Anonymizes one order in `tx` (the spec's table). False when the order was already done (two runs
 * overlapping) or is no longer eligible for `cutoff`; the guarded update makes the second a no-op.
 */
export async function anonymizeOrder(
  tx: DbTx,
  orderId: string,
  now: Date,
  cutoff: Date,
): Promise<boolean> {
  // Same lock as the store import, taken before reading: an import in flight finishes first, and
  // the next one sees the redaction and skips the order.
  const known = await tx.order.findUnique({ where: { id: orderId }, select: { wooOrderId: true } });
  if (!known) return false;
  await lockWooOrder(tx, known.wooOrderId);
  // Eligibility was decided outside the transaction: an import may since have moved the order back
  // into the workflow, or a return may have opened. Decide again, now that nothing else can change it.
  if ((await tx.order.count({ where: { id: orderId, ...eligible(cutoff) } })) === 0) return false;
  const order = await tx.order.findUnique({
    where: { id: orderId },
    include: { packages: { select: { id: true, labels: { select: { id: true } } } } },
  });
  if (!order || order.piiRedactedAt) return false;

  const claimed = await tx.order.updateMany({
    where: { id: orderId, piiRedactedAt: null },
    data: {
      customerName: "",
      customerEmail: null,
      customerNote: null,
      // The two required columns can't hold null, so an unusable value becomes `{}`.
      shippingAddress: reduceAddress(order.shippingAddress) ?? {},
      billingAddress: reduceAddress(order.billingAddress) ?? {},
      shipTo: reduceAddress(order.shipTo) ?? Prisma.DbNull,
      shipToOriginal: reduceAddress(order.shipToOriginal) ?? Prisma.DbNull,
      shipToMessages: [],
      externalChangeSummary: Prisma.DbNull,
      rawPayload: keptPayload(order.rawPayload),
      piiRedactedAt: now,
    },
  });
  if (claimed.count === 0) return false;

  await tx.orderItem.updateMany({ where: { orderId }, data: { metaData: [] } });

  const targets = [
    { entityType: "Order", ids: [orderId] },
    { entityType: "Package", ids: order.packages.map((p) => p.id) },
    { entityType: "ShippingLabel", ids: order.packages.flatMap((p) => p.labels.map((l) => l.id)) },
  ];
  for (const { entityType, ids } of targets) {
    if (ids.length === 0) continue;
    const events = await tx.auditEvent.findMany({ where: { entityType, entityId: { in: ids } } });
    for (const event of events) {
      const before = event.before === null ? undefined : scrubPii(event.before);
      const after = event.after === null ? undefined : scrubPii(event.after);
      if (
        JSON.stringify(before) === JSON.stringify(event.before ?? undefined) &&
        JSON.stringify(after) === JSON.stringify(event.after ?? undefined)
      )
        continue;
      await tx.auditEvent.update({
        where: { id: event.id },
        data: {
          ...(before === undefined ? {} : { before: before as Prisma.InputJsonValue }),
          ...(after === undefined ? {} : { after: after as Prisma.InputJsonValue }),
        },
      });
    }
  }

  await recordAudit(tx, operationsActor, {
    entityType: "Order",
    entityId: orderId,
    action: "pii.anonymize",
    at: now,
  });
  return true;
}
