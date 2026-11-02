import type {
  RepackBlockedLabel,
  RepackInput,
  RepackOrderResult,
  RepackResult,
} from "@woolrus/contracts";
import type { Db } from "@woolrus/db";
import { AppError } from "../errors";
import { linkIssueToRepack } from "../exceptions/issues";
import { storedResult } from "../idempotency";
import { type Actor, assertCan } from "../permissions";
import { type VoidLabelOptions, voidLabelStep } from "../qa/labels";
import { liveLabelStatuses } from "../workflow/gates";
import { lockOrder } from "../workflow/lock";
import { repack } from "../workflow/service";

// Repack (SPEC-shipping "Repack", FR-SHIP-08, SRS §7.1 #6): void every live label at its provider,
// and only when none is left live move the order back to Packing. Labels are never deleted.

const PROCEDURE = "shipping.repack";
/** Labels a void can be attempted for; a PURCHASING one has nothing to void yet. */
const voidable = ["ACTIVE", "VOID_REQUESTED", "VOID_REJECTED"];
const illegal = "errors.workflow.illegalTransition";

export type RepackOptions = VoidLabelOptions;

const liveLabels = (db: Db, orderId: string) =>
  db.shippingLabel.findMany({
    where: { status: { in: [...liveLabelStatuses] }, package: { orderId } },
    select: { id: true, status: true, error: true, package: { select: { number: true } } },
    orderBy: [{ package: { number: "asc" } }, { createdAt: "asc" }],
  });

const toBlocked = (
  labels: Awaited<ReturnType<typeof liveLabels>>,
  failures: Map<string, string>,
): RepackBlockedLabel[] =>
  labels.map((l) => ({
    labelId: l.id,
    packageNumber: l.package?.number ?? 0,
    status: l.status,
    error: failures.get(l.id) ?? l.error,
  }));

/**
 * Sends Ready orders back to Packing, 1–10 at a time, each on its own: an order whose void is
 * rejected or doesn't answer stays in Ready and the result names the package and why. Replays
 * return the first answer.
 */
export async function repackOrders(
  db: Db,
  actor: Actor,
  { orderIds, reason, issueId, idempotencyKey }: RepackInput,
  options: RepackOptions = {},
): Promise<RepackResult> {
  assertCan(actor, "order.repack");
  const previous = await db.$transaction((tx) =>
    storedResult<RepackResult>(tx, idempotencyKey, PROCEDURE, actor),
  );
  if (previous) return previous;

  const orders = await Promise.all(
    orderIds.map((orderId) => repackOne(db, actor, orderId, reason, issueId, options)),
  );
  const result: RepackResult = { orders };
  await db.idempotentRequest.upsert({
    where: { key: idempotencyKey },
    create: { key: idempotencyKey, procedure: PROCEDURE, userId: actor.userId, response: result },
    update: {},
  });
  return result;
}

async function repackOne(
  db: Db,
  actor: Actor,
  orderId: string,
  reason: string,
  issueId: string | undefined,
  options: RepackOptions,
): Promise<RepackOrderResult> {
  const refuse = (error: string, blocked: RepackBlockedLabel[] = []): RepackOrderResult => ({
    orderId,
    repacked: false,
    error,
    blocked,
  });
  const found = await db.order.findUnique({ where: { id: orderId }, select: { status: true } });
  if (!found) return refuse("errors.notFound");
  if (found.status !== "READY") return refuse(illegal);

  const failures = new Map<string, string>();
  for (const label of await liveLabels(db, orderId)) {
    if (!voidable.includes(label.status)) continue;
    try {
      await voidLabelStep(db, actor, { labelId: label.id, reason }, options);
    } catch (cause) {
      // A rejected void is a status, not an error; anything thrown leaves the label as it was.
      if (!(cause instanceof AppError)) throw cause;
      failures.set(label.id, cause.messageKey);
    }
  }

  const stillLive = await liveLabels(db, orderId);
  if (stillLive.length > 0)
    return { orderId, repacked: false, error: null, blocked: toBlocked(stillLive, failures) };

  const now = options.now ?? new Date();
  try {
    await db.$transaction(async (tx) => {
      const order = await lockOrder(tx, orderId);
      if (order.status !== "READY") throw new AppError("CONFLICT", illegal);
      const packages = await tx.package.findMany({
        where: { orderId },
        select: {
          id: true,
          labels: {
            where: { status: "VOIDED" },
            orderBy: { createdAt: "asc" },
            select: { id: true },
          },
        },
        orderBy: { number: "asc" },
      });
      const packageIds = packages.map((p) => p.id);
      await tx.shippingRate.deleteMany({ where: { packageId: { in: packageIds } } });
      await tx.package.updateMany({
        where: { id: { in: packageIds } },
        data: { ratesStatus: "NONE", ratesFetchedAt: null },
      });
      await tx.packageItem.updateMany({
        where: { packageId: { in: packageIds } },
        data: { qaVerifiedQuantity: 0, qaVerifiedAt: null, qaVerifiedById: null },
      });
      await repack(tx, actor, { orderId, expectedVersion: order.version, reason }, { now });
      if (issueId) {
        const issue = await tx.qualityIssue.findUnique({
          where: { id: issueId },
          select: { packageId: true },
        });
        const own = packages.find((p) => p.id === issue?.packageId)?.labels[0];
        const labelId =
          own?.id ??
          (
            await tx.shippingLabel.findFirst({
              where: { status: "VOIDED", package: { orderId } },
              orderBy: { createdAt: "asc" },
              select: { id: true },
            })
          )?.id;
        if (labelId) await linkIssueToRepack(tx, actor, { issueId, labelId }, { now });
      }
    });
  } catch (cause) {
    if (cause instanceof AppError) return refuse(cause.messageKey);
    throw cause;
  }
  return { orderId, repacked: true, error: null, blocked: [] };
}
