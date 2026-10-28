import type { QaLabel, QaPackage, QaPurchase, QaResult, QaView } from "@woolrus/contracts";
import type { DbTx, Prisma } from "@woolrus/db";
import { notFound } from "../errors";
import { openCriticalIssues } from "../exceptions/queries";
import { lineAndPackageNoteCounts } from "../notes/targets";
import { type Actor, assertCan } from "../permissions";
import { toNumber } from "../units";
import { toOrderDetails } from "../workflow/detail";
import { evaluateGate, loadGateSnapshot } from "../workflow/gates";
import { displayName, nameFields } from "../workflow/people";
import { toAttributes } from "../workflow/queries";

// What the QA screen reads (SPEC-qa "Reads"): each package's rows with their verified quantity,
// its label, the open critical issues and what still stops the order leaving QA.

export type QaOptions = { now?: Date };

const packageInclude = {
  box: { select: { name: true } },
  items: {
    orderBy: { packedAt: "asc" },
    include: {
      packedBy: { select: nameFields },
      qaVerifiedBy: { select: nameFields },
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
  const [packages, issues, notes, gate] = await Promise.all([
    tx.package.findMany({
      where: { orderId },
      include: packageInclude,
      orderBy: { number: "asc" },
    }),
    openCriticalIssues(tx, orderId),
    lineAndPackageNoteCounts(tx, orderId),
    loadGateSnapshot(tx, orderId),
  ]);

  const issueFor = (pkgId: string, orderItemId: string) =>
    issues.find((i) => i.orderItemId === orderItemId || i.packageId === pkgId)?.id ?? null;

  const view: QaPackage[] = packages.map((pkg) => {
    const rate = pkg.rates.find((r) => r.selected);
    const label = pkg.labels.find((l) => live.has(l.status)) ?? pkg.labels[0];
    return {
      id: pkg.id,
      number: pkg.number,
      boxName: pkg.box?.name ?? null,
      weightOz: toNumber(pkg.weightOz),
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
      })),
      selectedRate: rate
        ? {
            carrierCode: rate.carrierCode,
            serviceName: rate.serviceName,
            amountCents: rate.amountCents,
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
    unmet: evaluateGate("verified", gate).filter(
      (u) => u.messageKey !== "errors.workflow.gate.packageNoLabel",
    ),
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
