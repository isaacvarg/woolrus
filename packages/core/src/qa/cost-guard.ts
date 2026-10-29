import type { DbTx } from "@woolrus/db";
import { liveLabelStatuses } from "../workflow/gates";

// The cost guard (SPEC-qa "Cost guard"): Complete QA asks before buying labels that cost far more
// than the customer paid for shipping. The thresholds are two settings; empty turns a check off.

export type CostGuardSettings = {
  /** Ask when the labels cost more than this many times the shipping charged. */
  ratio: number | { toNumber(): number } | null;
  /** Ask when the labels cost more than this and the customer paid nothing for shipping. */
  freeCents: number | null;
};

/** Whether the labels' cost needs a "Buy anyway?" before anything is bought. */
export function needsCostConfirmation(
  labelCostCents: number,
  chargedCents: number,
  { ratio, freeCents }: CostGuardSettings,
): boolean {
  if (chargedCents > 0) {
    if (ratio === null) return false;
    const factor = typeof ratio === "number" ? ratio : ratio.toNumber();
    return labelCostCents > factor * chargedCents;
  }
  return freeCents !== null && labelCostCents > freeCents;
}

/**
 * What the order's labels cost: a package's live label at its cost (its quote while the price isn't
 * known yet), a package without one at its selected rate.
 */
export async function labelCostCents(tx: DbTx, orderId: string): Promise<number> {
  const packages = await tx.package.findMany({
    where: { orderId },
    select: {
      rates: { where: { selected: true }, select: { amountCents: true } },
      labels: {
        where: { status: { in: [...liveLabelStatuses] } },
        select: { costCents: true, quotedAmountCents: true },
      },
    },
  });
  return packages.reduce((sum, p) => {
    const label = p.labels[0];
    if (label) return sum + (label.costCents ?? label.quotedAmountCents ?? 0);
    return sum + (p.rates[0]?.amountCents ?? 0);
  }, 0);
}
