import type { DbTx, LabelStatus, PickStatus, WorkflowStatus } from "@woolrus/db";
import type { ErrorCode } from "@woolrus/i18n";
import { notFound } from "../errors";
import type { GateKind } from "./machine";

// Stage-exit gates (SPEC-workflow "Gates"). They read only the database, never the client, and say
// exactly what's missing so the UI can show it.

/** A label that exists or may exist at the carrier: an order with one can't be cancelled or repacked. */
export const liveLabelStatuses: readonly LabelStatus[] = [
  "PURCHASING",
  "ACTIVE",
  "VOID_REQUESTED",
  "VOID_REJECTED",
];

export type UnmetCondition = { messageKey: ErrorCode; params: Record<string, string | number> };

export type GateLine = {
  id: string;
  name: string;
  quantity: number;
  /** Σ quantity of the line's voids that aren't undone. */
  voidedQuantity: number;
  physical: boolean;
  pickStatus: PickStatus;
  pickedQuantity: number;
};

export type GatePackage = {
  id: string;
  number: number;
  hasBox: boolean;
  /** All three override dimensions are set. */
  hasDimensions: boolean;
  weightOz: number | null;
  items: { orderItemId: string; quantity: number; qaVerified: boolean }[];
  selectedRates: number;
  activeLabels: number;
  liveLabels: number;
};

export type GateSnapshot = { status: WorkflowStatus; lines: GateLine[]; packages: GatePackage[] };

const activeQuantity = (line: GateLine) => line.quantity - line.voidedQuantity;

/** Lines the floor handles: physical, with something left after voids. */
const workLines = (snap: GateSnapshot) =>
  snap.lines.filter((l) => l.physical && activeQuantity(l) > 0);

const unmet = (key: string, params: UnmetCondition["params"] = {}): UnmetCondition => ({
  messageKey: `errors.workflow.gate.${key}` as ErrorCode,
  params,
});

function picked(snap: GateSnapshot): UnmetCondition[] {
  return workLines(snap).flatMap((l) => {
    if (l.pickStatus === "PENDING") return [unmet("lineNotPicked", { line: l.name })];
    if (l.pickStatus === "OUT_OF_STOCK") return [unmet("lineOutOfStock", { line: l.name })];
    const expected = activeQuantity(l);
    return l.pickedQuantity === expected
      ? []
      : [unmet("linePickedQuantity", { line: l.name, picked: l.pickedQuantity, expected })];
  });
}

function packed(snap: GateSnapshot): UnmetCondition[] {
  const packedQty = new Map<string, number>();
  for (const p of snap.packages) {
    for (const it of p.items)
      packedQty.set(it.orderItemId, (packedQty.get(it.orderItemId) ?? 0) + it.quantity);
  }

  // Over-packing is checked on fully voided lines too: units in a box for a voided line are wrong.
  const lines = snap.lines
    .filter((l) => l.physical)
    .flatMap((l) => {
      const expected = activeQuantity(l);
      const qty = packedQty.get(l.id) ?? 0;
      if (qty > expected) return [unmet("lineOverPacked", { line: l.name, packed: qty, expected })];
      if (qty < expected)
        return [unmet("lineUnderPacked", { line: l.name, packed: qty, expected })];
      return [];
    });

  const packages = snap.packages.flatMap((p) => [
    ...(p.items.length === 0 ? [unmet("packageEmpty", { package: p.number })] : []),
    ...(!p.hasBox && !p.hasDimensions ? [unmet("packageNoBox", { package: p.number })] : []),
    ...(p.weightOz === null ? [unmet("packageNoWeight", { package: p.number })] : []),
  ]);

  return [...lines, ...packages];
}

function verified(snap: GateSnapshot): UnmetCondition[] {
  return snap.packages.flatMap((p) => {
    const unverified = p.items.filter((it) => !it.qaVerified).length;
    return [
      ...(unverified > 0
        ? [unmet("packageNotVerified", { package: p.number, count: unverified })]
        : []),
      ...(p.selectedRates !== 1 ? [unmet("packageNoRate", { package: p.number })] : []),
      ...(p.activeLabels !== 1 ? [unmet("packageNoLabel", { package: p.number })] : []),
    ];
  });
}

function shippable(snap: GateSnapshot): UnmetCondition[] {
  return [
    ...(snap.status !== "READY" ? [unmet("notReady")] : []),
    ...(snap.packages.length === 0 ? [unmet("noPackages")] : []),
    ...snap.packages
      .filter((p) => p.activeLabels === 0)
      .map((p) => unmet("packageNoLabel", { package: p.number })),
  ];
}

function noLiveLabels(snap: GateSnapshot): UnmetCondition[] {
  return snap.packages
    .filter((p) => p.liveLabels > 0)
    .map((p) => unmet("packageLiveLabel", { package: p.number }));
}

const gates: Record<GateKind, (snap: GateSnapshot) => UnmetCondition[]> = {
  picked,
  packed,
  verified,
  shippable,
  noLiveLabels,
};

/** The conditions `kind` still needs; empty when the gate is met. */
export function evaluateGate(kind: GateKind, snap: GateSnapshot): UnmetCondition[] {
  return gates[kind](snap);
}

/** Reads what the gates need, inside the transition's transaction. */
export async function loadGateSnapshot(tx: DbTx, orderId: string): Promise<GateSnapshot> {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: {
      status: true,
      items: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          name: true,
          quantity: true,
          pickStatus: true,
          pickedQuantity: true,
          product: { select: { physical: true } },
          voids: { where: { undoneAt: null }, select: { quantity: true } },
        },
      },
      packages: {
        orderBy: { number: "asc" },
        select: {
          id: true,
          number: true,
          boxId: true,
          lengthIn: true,
          widthIn: true,
          heightIn: true,
          weightOz: true,
          items: {
            orderBy: { packedAt: "asc" },
            select: { orderItemId: true, quantity: true, qaVerifiedAt: true },
          },
          rates: { where: { selected: true }, select: { id: true } },
          labels: { where: { status: { in: [...liveLabelStatuses] } }, select: { status: true } },
        },
      },
    },
  });
  if (!order) throw notFound();

  return {
    status: order.status,
    lines: order.items.map((it) => ({
      id: it.id,
      name: it.name,
      quantity: it.quantity,
      voidedQuantity: it.voids.reduce((sum, v) => sum + v.quantity, 0),
      // A line whose product is gone (deleted in the store) is treated as physical: the safe default.
      physical: it.product?.physical ?? true,
      pickStatus: it.pickStatus,
      pickedQuantity: it.pickedQuantity,
    })),
    packages: order.packages.map((p) => ({
      id: p.id,
      number: p.number,
      hasBox: p.boxId !== null,
      hasDimensions: p.lengthIn !== null && p.widthIn !== null && p.heightIn !== null,
      weightOz: p.weightOz === null ? null : p.weightOz.toNumber(),
      items: p.items.map((it) => ({
        orderItemId: it.orderItemId,
        quantity: it.quantity,
        qaVerified: it.qaVerifiedAt !== null,
      })),
      selectedRates: p.rates.length,
      activeLabels: p.labels.filter((l) => l.status === "ACTIVE").length,
      liveLabels: p.labels.length,
    })),
  };
}
