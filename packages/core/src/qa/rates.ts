import type {
  QaResult,
  RateSelectionReason,
  SelectRateInput,
  SetRateSelectionReasonInput,
} from "@woolrus/contracts";
import type { Db, DbTx, ShippingRate } from "@woolrus/db";
import type { ProviderId } from "../adapters/shipping/provider";
import { recordAudit } from "../audit";
import { cheapestPurchasable } from "../carriers/compare";
import { quoteOnlyProviders } from "../carriers/rates";
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

/** A note only explains "Other" (also refused by the contract; core is called directly too). */
function assertNote(reason: RateSelectionReason | null | undefined, note: string | undefined) {
  if (note !== undefined && reason !== "OTHER") {
    throw new AppError("BAD_REQUEST", "errors.qa.reasonNoteNeedsOther");
  }
}

/**
 * Locks the package's order for a rate choice: in QA, claimed by the actor, and the package without
 * a live label. Returns the order and the package's rates.
 */
async function lockForRateChoice(tx: DbTx, actor: Actor, packageId: string, now: Date) {
  const pkg = await tx.package.findUnique({
    where: { id: packageId },
    select: { orderId: true, discardedAt: true },
  });
  if (!pkg || pkg.discardedAt) throw notFound();
  const order = await lockForQa(tx, actor, pkg.orderId, now);
  // Read after the lock, so a refresh or a purchase can't slip in between.
  const live = await tx.shippingLabel.count({
    where: { packageId, status: { in: [...liveLabelStatuses] } },
  });
  if (live > 0) throw new AppError("CONFLICT", "errors.qa.packageHasLabel");
  const rates = await tx.shippingRate.findMany({ where: { packageId } });
  return { order, rates, quoteOnly: await quoteOnlyProviders(tx) };
}

/** A reason is only for a rate that isn't the cheapest one that can be bought, so the data stays clean. */
function assertReasonNeeded(
  rate: ShippingRate,
  rates: ShippingRate[],
  quoteOnly: ReadonlySet<ProviderId>,
) {
  if (cheapestPurchasable(rates, quoteOnly)?.id === rate.id) {
    throw new AppError("CONFLICT", "errors.qa.reasonNotNeeded");
  }
}

/** `assertNote` has already refused a note without OTHER. */
const reasonFields = (reason: RateSelectionReason | null, note: string | undefined) => ({
  selectionReason: reason,
  selectionNote: note ?? null,
});

/**
 * Selects `rateId` for the package, leaving exactly one selected, with QA's optional reason
 * (SPEC-rate-history "Choice and purchase"); the reason of the rate it replaces is cleared.
 * Refused for an expired rate, a quote-only rate, a rate of another package, a package with a live
 * label, or a reason on the cheapest rate. Choosing the selected rate again changes and audits
 * nothing, unless it brings a reason.
 */
export async function selectRate(
  db: Db,
  actor: Actor,
  { packageId, rateId, reason, note }: SelectRateInput,
  { now = new Date() }: QaOptions = {},
): Promise<QaResult> {
  assertCan(actor, "order.qa");
  assertNote(reason, note);
  return db.$transaction(async (tx) => {
    const { order, rates, quoteOnly } = await lockForRateChoice(tx, actor, packageId, now);
    const rate = rates.find((r) => r.id === rateId);
    if (!rate) throw notFound();
    if (rate.expiresAt && rate.expiresAt <= now) {
      throw new AppError("CONFLICT", "errors.qa.rateExpired");
    }
    if (quoteOnly.has(rate.provider)) {
      throw new AppError("CONFLICT", "errors.qa.rateQuoteOnly");
    }
    if (reason) assertReasonNeeded(rate, rates, quoteOnly);

    if (!rate.selected) {
      const previous = rates.find((r) => r.selected);
      // Unselect first: one selected rate per package is a unique index.
      await tx.shippingRate.updateMany({
        where: { packageId, selected: true },
        data: { selected: false, selectionReason: null, selectionNote: null },
      });
      await tx.shippingRate.update({
        where: { id: rate.id },
        data: { selected: true, ...reasonFields(reason ?? null, note) },
      });
      await recordAudit(tx, actor, {
        entityType: "Package",
        entityId: packageId,
        action: "rate.select",
        before: previous ? snapshot(previous) : undefined,
        after: { ...snapshot(rate), reason: reason ?? null },
        at: now,
      });
    } else if (reason) {
      await saveReason(tx, actor, rate, reason, note, now);
    } else {
      return qaResult(tx, order.id);
    }
    await touchClaim(tx, actor, order.id, { now });
    await notifyOrderChanged(tx, { id: order.id, status: order.status });
    return qaResult(tx, order.id);
  });
}

async function saveReason(
  tx: DbTx,
  actor: Actor,
  rate: ShippingRate,
  reason: RateSelectionReason | null,
  note: string | undefined,
  now: Date,
) {
  const fields = reasonFields(reason, note);
  await tx.shippingRate.update({ where: { id: rate.id }, data: fields });
  await recordAudit(tx, actor, {
    entityType: "Package",
    entityId: rate.packageId,
    action: "rate.reason",
    before: { rateId: rate.id, reason: rate.selectionReason },
    after: { rateId: rate.id, reason: fields.selectionReason },
    at: now,
  });
}

/**
 * Adds, changes or (with null) clears why the package's selected rate isn't the cheapest, without
 * selecting again. Same preconditions as `selectRate`. Audited as `rate.reason`.
 */
export async function setRateSelectionReason(
  db: Db,
  actor: Actor,
  { packageId, reason, note }: SetRateSelectionReasonInput,
  { now = new Date() }: QaOptions = {},
): Promise<QaResult> {
  assertCan(actor, "order.qa");
  assertNote(reason, note);
  return db.$transaction(async (tx) => {
    const { order, rates, quoteOnly } = await lockForRateChoice(tx, actor, packageId, now);
    const rate = rates.find((r) => r.selected);
    if (!rate) throw new AppError("CONFLICT", "errors.qa.noRateSelected");
    if (reason) assertReasonNeeded(rate, rates, quoteOnly);
    await saveReason(tx, actor, rate, reason, note, now);
    await touchClaim(tx, actor, order.id, { now });
    await notifyOrderChanged(tx, { id: order.id, status: order.status });
    return qaResult(tx, order.id);
  });
}
