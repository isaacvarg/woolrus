import type { OrderDetail, OrderVersionInput } from "@woolrus/contracts";
import type { Db, DbTx, LabelStatus, Order } from "@woolrus/db";
import type { ErrorCode } from "@woolrus/i18n";
import { recordAudit } from "../audit";
import { enqueue } from "../enqueue";
import { AppError, type UnmetCondition } from "../errors";
import { uuidv7 } from "../ids";
import { queues } from "../jobs";
import { type Actor, assertCan } from "../permissions";
import { toOrderDetails } from "../workflow/detail";
import {
  evaluateGate,
  type GateSnapshot,
  liveLabelStatuses,
  loadGateSnapshot,
} from "../workflow/gates";
import { notifyOrderChanged } from "../workflow/notify";
import { transition } from "../workflow/service";
import type { QaOptions } from "./queries";
import { lockForQa } from "./verify";

// Complete QA (SPEC-qa "Complete QA"): the request checks the preconditions and records the intent
// to buy; the `labels.purchase` job buys (qa/purchase.ts). One way in: the `orders.completeQa` route.

export type PurchasePackage = {
  number: number;
  /** The selected rate, if there is one. */
  rate: { provider: string; expiresAt: Date | null } | null;
  /** Statuses of the package's live labels. */
  labels: readonly { status: LabelStatus; storageKey: string | null }[];
};

/** An ACTIVE label whose PDF is in our storage: nothing left to buy or copy. */
export const isStored = (l: { status: LabelStatus; storageKey: string | null }) =>
  l.status === "ACTIVE" && l.storageKey !== null;

/** Whether the package still needs a label bought (it has no live one). */
export const needsLabel = (pkg: PurchasePackage) => pkg.labels.length === 0;

const key = (name: string): ErrorCode => `errors.qa.${name}` as ErrorCode;

/**
 * What stops Complete QA from starting: the **verified** gate without its label condition (buying
 * them is the point), a purchase already running, and, for each package still to buy, an expired
 * rate or a provider that's off. Pure, so the screen shows the same list the request enforces.
 */
export function purchasePreconditions({
  gate,
  packages,
  enabledProviders,
  now,
}: {
  gate: readonly UnmetCondition[];
  packages: readonly PurchasePackage[];
  enabledProviders: ReadonlySet<string>;
  now: Date;
}): UnmetCondition[] {
  const conditions = gate.filter((u) => u.messageKey !== "errors.workflow.gate.packageNoLabel");
  if (packages.some((p) => p.labels.some((l) => l.status === "PURCHASING"))) {
    conditions.push({ messageKey: key("purchaseInProgress"), params: {} });
  }
  for (const pkg of packages.filter(needsLabel)) {
    if (!pkg.rate) continue; // the gate already says so
    if (pkg.rate.expiresAt && pkg.rate.expiresAt <= now) {
      conditions.push({ messageKey: key("packageRateExpired"), params: { package: pkg.number } });
    }
    if (!enabledProviders.has(pkg.rate.provider)) {
      conditions.push({ messageKey: key("packageProviderOff"), params: { package: pkg.number } });
    }
  }
  return conditions;
}

/** The packages and providers `purchasePreconditions` reads. */
async function loadPurchaseInputs(tx: DbTx, orderId: string) {
  const [packages, accounts] = await Promise.all([
    tx.package.findMany({
      where: { orderId },
      orderBy: { number: "asc" },
      select: {
        number: true,
        rates: { where: { selected: true }, select: { provider: true, expiresAt: true } },
        labels: {
          where: { status: { in: [...liveLabelStatuses] } },
          select: { status: true, storageKey: true },
        },
      },
    }),
    tx.shippingProviderAccount.findMany({ where: { enabled: true }, select: { provider: true } }),
  ]);
  return {
    packages: packages.map((p) => ({
      number: p.number,
      rate: p.rates[0] ?? null,
      labels: p.labels,
    })),
    enabledProviders: new Set<string>(accounts.map((a) => a.provider)),
  };
}

/** The unmet preconditions of Complete QA for an order, as the screen and the request see them. */
export async function purchaseConditions(
  tx: DbTx,
  orderId: string,
  now: Date,
  gateSnapshot?: GateSnapshot,
): Promise<UnmetCondition[]> {
  const [inputs, snapshot] = await Promise.all([
    loadPurchaseInputs(tx, orderId),
    gateSnapshot ?? loadGateSnapshot(tx, orderId),
  ]);
  return purchasePreconditions({ gate: evaluateGate("verified", snapshot), now, ...inputs });
}

export type CompleteQaInput = { orderId: string; expectedVersion: number };

/**
 * Complete QA. With every package's label bought and stored, it only moves the order to Ready.
 * Otherwise it records a `PURCHASING` label for each package without one, queues `labels.purchase`
 * and returns at once: the job buys the labels and makes the move.
 */
export async function completeQaWithLabels(
  db: Db,
  actor: Actor,
  { orderId, expectedVersion }: CompleteQaInput,
  { now = new Date() }: QaOptions = {},
): Promise<Order> {
  assertCan(actor, "order.qa");
  assertCan(actor, "label.purchase");
  return db.$transaction(async (tx) => {
    const order = await lockForQa(tx, actor, orderId, now);
    if (order.version !== expectedVersion) throw new AppError("CONFLICT", "errors.workflow.stale");

    const unmet = await purchaseConditions(tx, orderId, now);
    if (unmet.length > 0) {
      throw new AppError("CONFLICT", "errors.workflow.gateFailed", undefined, { unmet });
    }

    const packages = await tx.package.findMany({
      where: { orderId },
      orderBy: { number: "asc" },
      include: {
        rates: { where: { selected: true } },
        labels: {
          where: { status: { in: [...liveLabelStatuses] } },
          select: { status: true, storageKey: true },
        },
      },
    });
    if (packages.every((p) => p.labels.length > 0 && p.labels.every(isStored))) {
      // The retry after a final move that didn't happen: nothing to buy.
      return transition(
        tx,
        actor,
        { orderId, expectedVersion, to: "READY", kind: "completeQa" },
        { now },
      );
    }

    const toBuy = packages.filter((p) => p.labels.length === 0);
    for (const pkg of toBuy) {
      const rate = pkg.rates[0];
      if (!rate) continue; // refused above
      await tx.shippingLabel.create({
        data: {
          packageId: pkg.id,
          status: "PURCHASING",
          provider: rate.provider,
          idempotencyKey: uuidv7(),
          carrierId: rate.carrierId,
          serviceId: rate.serviceId,
          carrierCode: rate.carrierCode,
          serviceCode: rate.serviceCode,
          quotedAmountCents: rate.amountCents,
          currency: rate.currency,
          purchasedById: actor.userId,
        },
      });
    }

    const updated = await tx.order.update({
      where: { id: orderId },
      data: { version: { increment: 1 }, claimedAt: now },
    });
    await recordAudit(tx, actor, {
      entityType: "Order",
      entityId: orderId,
      action: "labels.purchaseRequested",
      after: { packages: toBuy.map((p) => p.number) },
      at: now,
    });
    if (actor.userId !== null) {
      await enqueue(
        tx,
        queues.labelsPurchase,
        { orderId, requestedById: actor.userId },
        { singletonKey: orderId },
      );
    }
    await notifyOrderChanged(tx, { id: orderId, status: order.status });
    return updated;
  });
}

/** The `orders.completeQa` handler: Complete QA, answered as the order's API shape. */
export async function completeQaOrder(
  db: Db,
  actor: Actor,
  { id, expectedVersion }: OrderVersionInput,
): Promise<OrderDetail> {
  const order = await completeQaWithLabels(db, actor, { orderId: id, expectedVersion });
  const [detail] = await toOrderDetails(db, [order]);
  return detail as OrderDetail;
}
