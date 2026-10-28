import type { QaResult, ScanVerifyInput } from "@woolrus/contracts";
import type { Db } from "@woolrus/db";
import { recordAudit } from "../audit";
import { AppError, notFound } from "../errors";
import { storedResult, withIdempotency } from "../idempotency";
import { type Actor, assertCan, can } from "../permissions";
import { normalizeCode } from "../picking/codes";
import { matchingLines, notOnOrder } from "../picking/scan";
import { lineInclude } from "../picking/service";
import { touchClaim } from "../workflow/claims";
import { notifyOrderChanged } from "../workflow/notify";
import { type QaOptions, qaResult } from "./queries";
import { lockForQa } from "./verify";

// Scan to verify (SPEC-qa "Verification"): one scanned code is one unit on the first row of the
// focused package that still needs it. A refused scan throws, so it changes and audits nothing.

/** Adds one verified unit to the package's first matching unfinished row. Idempotent on `scanId`. */
export async function scanVerify(
  db: Db,
  actor: Actor,
  { orderId, packageId, code, scanId }: ScanVerifyInput,
  { now = new Date() }: QaOptions = {},
): Promise<QaResult> {
  assertCan(actor, "order.qa");
  const wanted = normalizeCode(code);
  return db.$transaction(async (tx) => {
    const pkg = await tx.package.findUnique({
      where: { id: packageId },
      select: { orderId: true },
    });
    if (!pkg || pkg.orderId !== orderId) throw notFound();

    // A replay answers before the checks, which may no longer pass (the order moved on).
    if (await storedResult(tx, scanId, "qa.scan", actor)) return qaResult(tx, orderId);

    const order = await lockForQa(tx, actor, orderId, now);
    await withIdempotency(tx, scanId, "qa.scan", actor, async () => {
      if (
        (await tx.shippingLabel.count({ where: { package: { orderId }, status: "PURCHASING" } })) >
        0
      ) {
        throw new AppError("CONFLICT", "errors.qa.purchaseInProgress");
      }
      const items = await tx.orderItem.findMany({ where: { orderId }, include: lineInclude });
      const matching = matchingLines(items, wanted);
      const first = matching[0];
      if (!first) throw await notOnOrder(tx, wanted, can(actor, "product.manage"), SCAN_NOT_ON);

      const rows = await tx.packageItem.findMany({
        where: { package: { orderId }, orderItemId: { in: matching.map((m) => m.id) } },
        include: { package: { select: { number: true } } },
      });
      // Pick order across matching lines, then the order the rows were packed.
      const rank = new Map(matching.map((m, i) => [m.id, i]));
      rows.sort(
        (a, b) =>
          (rank.get(a.orderItemId) ?? 0) - (rank.get(b.orderItemId) ?? 0) ||
          a.packedAt.getTime() - b.packedAt.getTime(),
      );

      const here = rows.filter((r) => r.packageId === packageId);
      if (here.length === 0) {
        const other = rows[0];
        if (other) {
          throw new AppError("CONFLICT", "errors.qa.scanOtherPackage", undefined, {
            params: { package: other.package.number },
          });
        }
        // On the order but in no package (voided to nothing, or never packed).
        throw new AppError("CONFLICT", SCAN_NOT_ON, undefined, { params: { name: first.name } });
      }
      const target = here.find((r) => r.qaVerifiedQuantity < r.quantity);
      if (!target) {
        throw new AppError("CONFLICT", "errors.qa.scanAlreadyVerified", undefined, {
          params: { line: first.name },
        });
      }

      const verified = target.qaVerifiedQuantity + 1;
      const complete = verified === target.quantity;
      await tx.packageItem.update({
        where: { id: target.id },
        data: {
          qaVerifiedQuantity: verified,
          qaVerifiedAt: complete ? now : null,
          qaVerifiedById: complete ? actor.userId : null,
        },
      });
      await recordAudit(tx, actor, {
        entityType: "PackageItem",
        entityId: target.id,
        action: "packageItem.scan",
        before: { verifiedQuantity: target.qaVerifiedQuantity, quantity: target.quantity },
        after: { verifiedQuantity: verified, quantity: target.quantity },
        at: now,
      });
      await touchClaim(tx, actor, orderId, { now });
      await notifyOrderChanged(tx, { id: order.id, status: order.status });
      return { packageItemId: target.id };
    });
    return qaResult(tx, orderId);
  });
}

const SCAN_NOT_ON = "errors.qa.scanNotOnOrder" as const;
