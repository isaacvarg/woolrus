import type { QaResult, SelectRateInput } from "@woolrus/contracts";
import type { Db } from "@woolrus/db";
import { recordAudit } from "../audit";
import { AppError, notFound } from "../errors";
import { type Actor, assertCan } from "../permissions";
import { touchClaim } from "../workflow/claims";
import { liveLabelStatuses } from "../workflow/gates";
import { notifyOrderChanged } from "../workflow/notify";
import { type QaOptions, qaResult } from "./queries";
import { lockForQa } from "./verify";

// Rate choice (SPEC-qa "Rate selection"). Like verification, it doesn't bump Order.version.

const snapshot = (rate: { id: string; amountCents: number; serviceName: string }) => ({
  rateId: rate.id,
  amountCents: rate.amountCents,
  serviceName: rate.serviceName,
});

/**
 * Selects `rateId` for the package, leaving exactly one selected. Refused for an expired rate, a
 * rate of another package, or a package with a live label; choosing the selected rate again
 * changes and audits nothing.
 */
export async function selectRate(
  db: Db,
  actor: Actor,
  { packageId, rateId }: SelectRateInput,
  { now = new Date() }: QaOptions = {},
): Promise<QaResult> {
  assertCan(actor, "order.qa");
  return db.$transaction(async (tx) => {
    const pkg = await tx.package.findUnique({
      where: { id: packageId },
      select: { orderId: true },
    });
    if (!pkg) throw notFound();
    const { orderId } = pkg;
    const order = await lockForQa(tx, actor, orderId, now);

    // Read after the lock, so a refresh or a purchase can't slip in between.
    const rate = await tx.shippingRate.findFirst({ where: { id: rateId, packageId } });
    if (!rate) throw notFound();
    const live = await tx.shippingLabel.count({
      where: { packageId, status: { in: [...liveLabelStatuses] } },
    });
    if (live > 0) throw new AppError("CONFLICT", "errors.qa.packageHasLabel");
    if (rate.expiresAt && rate.expiresAt <= now) {
      throw new AppError("CONFLICT", "errors.qa.rateExpired");
    }

    if (!rate.selected) {
      const previous = await tx.shippingRate.findFirst({ where: { packageId, selected: true } });
      // Unselect first: one selected rate per package is a unique index.
      await tx.shippingRate.updateMany({
        where: { packageId, selected: true },
        data: { selected: false },
      });
      await tx.shippingRate.update({ where: { id: rate.id }, data: { selected: true } });
      await recordAudit(tx, actor, {
        entityType: "Package",
        entityId: packageId,
        action: "rate.select",
        before: previous ? snapshot(previous) : undefined,
        after: snapshot(rate),
        at: now,
      });
      await touchClaim(tx, actor, orderId, { now });
      await notifyOrderChanged(tx, { id: order.id, status: order.status });
    }
    return qaResult(tx, orderId);
  });
}
