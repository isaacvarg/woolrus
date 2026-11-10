// The split rule (SPEC-lumexia "Capturing lots", decision 2). Pure: callers load a box line's lots
// under the order lock, ask these for the lots it should have, and write the difference.
//
// Once a box line has any lot, its lots cover all its units. The lowest `position` is the default
// lot, which gives and takes units as lots are scanned and units are packed or unpacked.

export type LotSlot = {
  /** Unset for a lot the plan adds. */
  id?: string;
  lotNumber: string | null;
  lumexiaLotId: string | null;
  quantity: number;
  position: number;
};

export type LotRef = { lotNumber: string | null; lumexiaLotId: string | null };

export type LotPlan = { ok: true; lots: LotSlot[] } | { ok: false; reason: "allUnitsHaveLots" };

const byPosition = (lots: readonly LotSlot[]) =>
  [...lots].sort((a, b) => a.position - b.position).map((l) => ({ ...l }));

const sameLot = (a: LotRef, b: LotRef) =>
  (a.lotNumber !== null && a.lotNumber === b.lotNumber) ||
  (a.lumexiaLotId !== null && a.lumexiaLotId === b.lumexiaLotId);

/**
 * Where the next unit for `target` comes from: the default lot while it has more than 1, else the
 * lot with the most units (ties: earliest). Never `target` itself, and never a lot down to 1.
 */
function donorFor(lots: LotSlot[], target: LotSlot | undefined): LotSlot | undefined {
  const [first] = lots;
  if (first && first !== target && first.quantity > 1) return first;
  let best: LotSlot | undefined;
  for (const lot of lots) {
    if (lot === target || lot.quantity <= 1) continue;
    if (!best || lot.quantity > best.quantity) best = lot;
  }
  return best;
}

/**
 * A lot scanned into a box line of `boxQuantity` units. The first lot takes every unit; scanning a
 * lot already on the line moves one more unit to it; a new lot takes one unit. Refused when no lot
 * can give a unit (every unit already has its own lot).
 */
export function scanLotInto(
  current: readonly LotSlot[],
  boxQuantity: number,
  lot: LotRef,
): LotPlan {
  const lots = byPosition(current);
  if (lots.length === 0) {
    return { ok: true, lots: [{ ...lot, quantity: boxQuantity, position: 0 }] };
  }
  const existing = lots.find((l) => sameLot(l, lot));
  const donor = donorFor(lots, existing);
  if (!donor) return { ok: false, reason: "allUnitsHaveLots" };
  donor.quantity -= 1;
  if (existing) {
    existing.quantity += 1;
    return { ok: true, lots };
  }
  const position = Math.max(...lots.map((l) => l.position)) + 1;
  return { ok: true, lots: [...lots, { ...lot, quantity: 1, position }] };
}

/** Units packed into a box line that has lots go to its default lot. */
export function addUnitsToLots(current: readonly LotSlot[], units: number): LotSlot[] {
  const lots = byPosition(current);
  const [first] = lots;
  if (first) first.quantity += units;
  return lots;
}

/**
 * Units taken out of a box line come from the default lot down to 1, then from the latest-scanned
 * lot; a lot left with nothing goes. Taking out every unit leaves no lots.
 */
export function removeUnitsFromLots(current: readonly LotSlot[], units: number): LotSlot[] {
  const lots = byPosition(current);
  let left = units;
  const [first] = lots;
  if (first) {
    const take = Math.min(Math.max(first.quantity - 1, 0), left);
    first.quantity -= take;
    left -= take;
  }
  for (let i = lots.length - 1; i >= 0 && left > 0; i--) {
    const lot = lots[i] as LotSlot;
    const take = Math.min(lot.quantity, left);
    lot.quantity -= take;
    left -= take;
  }
  return lots.filter((l) => l.quantity > 0);
}
