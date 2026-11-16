import type {
  QaLabel,
  QaPackage,
  QaPurchase,
  QaResult,
  QaTrip,
  QaView,
  Trip,
} from "@woolrus/contracts";
import type { DbTx, Prisma } from "@woolrus/db";
import { cheapestPurchasable } from "../carriers/compare";
import { quoteOnlyProviders } from "../carriers/rates";
import { notFound } from "../errors";
import { openCriticalIssues } from "../exceptions/queries";
import { lotOrder, toLotDtos } from "../lumexia/lot-store";
import { lineAndPackageNoteCounts } from "../notes/targets";
import { type Actor, assertCan } from "../permissions";
import { toNumber } from "../units";
import { toOrderDetails } from "../workflow/detail";
import { loadGateSnapshot } from "../workflow/gates";
import { displayName, nameFields } from "../workflow/people";
import { toAttributes } from "../workflow/queries";
import { purchaseConditions } from "./complete";

// What the QA screen reads (SPEC-qa "Reads"): each package's rows with their verified quantity,
// its label, the open critical issues and what still stops the order leaving QA.

export type QaOptions = { now?: Date };

const packageInclude = {
  box: { select: { name: true, lengthIn: true, widthIn: true, heightIn: true } },
  boxConfirmedBy: { select: nameFields },
  checkTrips: {
    orderBy: { check: "asc" },
    include: {
      acknowledgedBy: { select: nameFields },
      approval: { include: { approvedBy: { select: nameFields } } },
    },
  },
  items: {
    orderBy: { packedAt: "asc" },
    include: {
      packedBy: { select: nameFields },
      qaVerifiedBy: { select: nameFields },
      lots: { orderBy: lotOrder },
      orderItem: { include: { pickedBy: { select: nameFields } } },
    },
  },
  rates: { orderBy: [{ amountCents: "asc" }, { id: "asc" }] },
  labels: { orderBy: { createdAt: "desc" }, include: { purchasedBy: { select: nameFields } } },
} as const satisfies Prisma.PackageInclude;

type LabelRow = Prisma.PackageGetPayload<{ include: typeof packageInclude }>["labels"][number];

const live = new Set(["PURCHASING", "ACTIVE", "VOID_REQUESTED", "VOID_REJECTED"]);

const toLabel = (label: LabelRow): QaLabel => ({
  id: label.id,
  status: label.status,
  trackingNumber: label.trackingNumber,
  carrierCode: label.carrierCode,
  serviceCode: label.serviceCode,
  costCents: label.costCents,
  quotedAmountCents: label.quotedAmountCents,
  error: label.error,
  purchasedBy: label.purchasedBy ? displayName(label.purchasedBy) : null,
  purchasedAt: label.purchasedAt,
});

type TripRow = Prisma.PackageGetPayload<{
  include: typeof packageInclude;
}>["checkTrips"][number];

type ForcedMove = { at: Date; reason: string; by: string | null };

/**
 * An Admin's force-status moves into QA from Packing, or from a hold placed in Packing: they save
 * trips without an approval. Each is matched to its rows by time, as `transition` writes both at
 * one `now`.
 */
async function forcedIntoQa(tx: DbTx, orderId: string): Promise<ForcedMove[]> {
  const events = await tx.orderStageEvent.findMany({
    // Only force-status gives a reason for these moves; completing packing and resume never do.
    where: {
      orderId,
      fromStatus: { in: ["PACKING", "ON_HOLD"] },
      toStatus: "QA",
      reason: { not: null },
    },
    include: { actor: { select: nameFields } },
  });
  return events.map((e) => ({
    at: e.at,
    reason: e.reason ?? "",
    by: e.actor ? displayName(e.actor) : null,
  }));
}

type Sized = {
  lengthIn: Prisma.Decimal | null;
  widthIn: Prisma.Decimal | null;
  heightIn: Prisma.Decimal | null;
};

const sizeOf = ({ lengthIn, widthIn, heightIn }: Sized) =>
  lengthIn && widthIn && heightIn
    ? { lengthIn: lengthIn.toNumber(), widthIn: widthIn.toNumber(), heightIn: heightIn.toNumber() }
    : null;

function toQaTrip(row: TripRow, forced: readonly ForcedMove[]): QaTrip {
  // The trip and the stage event were written by the same move, with the same timestamp.
  const move = forced.find((m) => m.at.getTime() === row.createdAt.getTime());
  return {
    id: row.id,
    // Written from `evaluateChecks`' own output, so the details fit the contract.
    trip: { check: row.check, mode: row.mode, details: row.details } as Trip,
    approval: row.approval
      ? {
          approver: displayName(row.approval.approvedBy),
          reason: row.approval.reason,
          at: row.approval.createdAt,
        }
      : null,
    forced: move && !row.approval ? move : null,
    acknowledgedBy: row.acknowledgedBy ? displayName(row.acknowledgedBy) : null,
    acknowledgedAt: row.acknowledgedAt,
  };
}

function purchaseState(packages: Prisma.PackageGetPayload<{ include: typeof packageInclude }>[]) {
  const labelsOf = (p: (typeof packages)[number]) => p.labels;
  const all = packages.flatMap(labelsOf);
  if (all.some((l) => l.status === "PURCHASING")) {
    const bought = packages.filter((p) => p.labels.some((l) => l.status === "ACTIVE")).length;
    return { kind: "purchasing", bought, total: packages.length } satisfies QaPurchase;
  }
  const failed = packages
    .filter(
      (p) => !p.labels.some((l) => live.has(l.status)) && p.labels[0]?.status === "PURCHASE_FAILED",
    )
    .map((p) => p.number);
  return failed.length > 0
    ? ({ kind: "failed", packages: failed } satisfies QaPurchase)
    : ({ kind: "idle" } satisfies QaPurchase);
}

/** The packages and gate as every QA write returns them. */
export async function qaResult(
  tx: DbTx,
  orderId: string,
  { now = new Date() }: QaOptions = {},
): Promise<QaResult> {
  const [packages, issues, notes, gate, quoteOnly, forcedMoves] = await Promise.all([
    tx.package.findMany({
      where: { orderId, discardedAt: null },
      include: packageInclude,
      orderBy: { number: "asc" },
    }),
    openCriticalIssues(tx, orderId),
    lineAndPackageNoteCounts(tx, orderId),
    loadGateSnapshot(tx, orderId),
    quoteOnlyProviders(tx),
    forcedIntoQa(tx, orderId),
  ]);

  // The gate already read the lot rules for each line.
  const lotLines = new Set(gate.lines.filter((l) => l.needsLot).map((l) => l.id));
  const issueFor = (pkgId: string, orderItemId: string) =>
    issues.find((i) => i.orderItemId === orderItemId || i.packageId === pkgId)?.id ?? null;

  const view: QaPackage[] = packages.map((pkg) => {
    const rate = pkg.rates.find((r) => r.selected);
    const cheapest = cheapestPurchasable(pkg.rates, quoteOnly);
    const label = pkg.labels.find((l) => live.has(l.status)) ?? pkg.labels[0];
    return {
      id: pkg.id,
      number: pkg.number,
      boxName: pkg.box?.name ?? null,
      weightOz: toNumber(pkg.weightOz),
      dimensions: sizeOf(pkg.box ?? pkg),
      trips: pkg.checkTrips.map((row) => toQaTrip(row, forcedMoves)),
      boxConfirmRequired: gate.packages.find((p) => p.id === pkg.id)?.boxConfirmRequired ?? false,
      boxConfirmed: pkg.boxConfirmedAt
        ? {
            by: pkg.boxConfirmedBy ? displayName(pkg.boxConfirmedBy) : null,
            at: pkg.boxConfirmedAt,
          }
        : null,
      rows: pkg.items.map((it) => ({
        id: it.id,
        orderItemId: it.orderItemId,
        name: it.orderItem.name,
        sku: it.orderItem.sku,
        imageUrl: it.orderItem.imageUrl,
        attributes: toAttributes(it.orderItem.attributes),
        quantity: it.quantity,
        verifiedQuantity: it.qaVerifiedQuantity,
        verifiedBy: it.qaVerifiedBy ? displayName(it.qaVerifiedBy) : null,
        verifiedAt: it.qaVerifiedAt,
        pickedBy: it.orderItem.pickedBy ? displayName(it.orderItem.pickedBy) : null,
        packedBy: it.packedBy ? displayName(it.packedBy) : null,
        criticalIssueId: issueFor(pkg.id, it.orderItemId),
        needsLot: lotLines.has(it.orderItemId),
        lots: toLotDtos(it.lots),
      })),
      label: label ? toLabel(label) : null,
      rates: pkg.rates.map((r) => ({
        id: r.id,
        carrierCode: r.carrierCode,
        serviceName: r.serviceName,
        amountCents: r.amountCents,
        deliveryDays: r.deliveryDays,
        selected: r.selected,
        expired: r.expiresAt !== null && r.expiresAt <= now,
        quoteOnly: quoteOnly.has(r.provider),
        cheapest: r === cheapest,
      })),
      selectedRate: rate
        ? {
            carrierCode: rate.carrierCode,
            serviceName: rate.serviceName,
            amountCents: rate.amountCents,
            reason: rate.selectionReason,
            note: rate.selectionNote,
          }
        : null,
      noteCount: notes.packages.get(pkg.id) ?? 0,
    };
  });

  return {
    packages: view,
    orderIssueIds: issues.filter((i) => !i.orderItemId && !i.packageId).map((i) => i.id),
    purchase: purchaseState(packages),
    // Buying the labels is Complete QA's own job, so a missing label isn't something to fix first.
    unmet: await purchaseConditions(tx, orderId, now, gate),
  };
}

/** The QA screen for one order. */
export async function getQaScreen(
  db: DbTx,
  actor: Actor,
  { orderId }: { orderId: string },
  { now = new Date() }: QaOptions = {},
): Promise<QaView> {
  assertCan(actor, "order.read");
  const order = await db.order.findUnique({ where: { id: orderId } });
  if (!order) throw notFound();
  const [[detail], result] = await Promise.all([
    toOrderDetails(db, [order], { now }),
    qaResult(db, orderId, { now }),
  ]);
  if (!detail) throw notFound();
  return { order: detail, customerNote: order.customerNote, ...result };
}
