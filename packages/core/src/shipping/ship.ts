import type { ShipOrderResult, ShipOrdersInput, ShipOrdersResult } from "@woolrus/contracts";
import type { Db } from "@woolrus/db";
import { enqueue } from "../enqueue";
import { AppError } from "../errors";
import { storedResult, withIdempotency } from "../idempotency";
import { queues } from "../jobs";
import { type Actor, assertCan } from "../permissions";
import { ship } from "../workflow/service";

// Shipping Ready orders (SPEC-shipping "Ship", FR-SHIP-05, SRS §7.1 #7). The unprinted check reads
// first and writes nothing; then each order moves in its own transaction, so one failing doesn't
// stop the rest, and its woo.push job commits (or rolls back) with its status change.

/** Ready → Completed for each order, with a `woo.push` job per shipped order. Replays return the first answer. */
export async function shipOrders(
  db: Db,
  actor: Actor,
  input: ShipOrdersInput,
  { now = new Date() }: { now?: Date } = {},
): Promise<ShipOrdersResult> {
  assertCan(actor, "order.ship");
  const orderIds = [...new Set(input.orderIds)];

  const replay = await db.$transaction((tx) =>
    storedResult<ShipOrdersResult>(tx, input.idempotencyKey, "shipping.shipOrders", actor),
  );
  if (replay) return replay;

  if (!input.confirmUnprinted) {
    const unprinted = await db.order.findMany({
      where: {
        id: { in: orderIds },
        packages: { some: { labels: { some: { status: "ACTIVE", printCount: 0 } } } },
      },
      select: { number: true },
      orderBy: { number: "asc" },
    });
    if (unprinted.length > 0) {
      throw new AppError("CONFLICT", "errors.shipping.unprintedLabels", undefined, {
        params: { orderNumbers: unprinted.map((o) => o.number).join(", ") },
      });
    }
  }

  const results: ShipOrderResult[] = [];
  for (const orderId of orderIds) results.push(await shipOne(db, actor, orderId, now));

  const result = { results };
  // The moves above are already committed; the key only has to hold the answer for replays.
  await db.$transaction((tx) =>
    withIdempotency(tx, input.idempotencyKey, "shipping.shipOrders", actor, async () => result),
  );
  return result;
}

async function shipOne(db: Db, actor: Actor, orderId: string, now: Date): Promise<ShipOrderResult> {
  const known = await db.order.findUnique({
    where: { id: orderId },
    select: { number: true, version: true },
  });
  if (!known) {
    return {
      orderId,
      orderNumber: "",
      ok: false,
      messageKey: "errors.notFound",
      params: {},
    };
  }
  try {
    await db.$transaction(async (tx) => {
      const fresh = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
        select: { version: true },
      });
      await ship(tx, actor, { orderId, expectedVersion: fresh.version }, { now });
      await tx.order.update({
        where: { id: orderId },
        data: { wooPushStatus: "PENDING", wooPushAttempts: 0, wooPushError: null },
      });
      await enqueue(tx, queues.wooPush, { orderId }, { singletonKey: orderId });
    });
    return { orderId, orderNumber: known.number, ok: true };
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return {
      orderId,
      orderNumber: known.number,
      ok: false,
      messageKey: error.messageKey,
      params: error.params ?? {},
    };
  }
}
