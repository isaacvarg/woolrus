import { describe, expect, it } from "vitest";
import {
  addUnitsToLots,
  type LotPlan,
  type LotSlot,
  removeUnitsFromLots,
  scanLotInto,
} from "./split";

// SPEC-lumexia success criterion 6: the split rule.

const ref = (lotNumber: string) => ({ lotNumber, lumexiaLotId: null });
const lots = (plan: LotPlan) => {
  if (!plan.ok) throw new Error(plan.reason);
  return plan.lots;
};
/** "A:2 B:1", in position order. */
const show = (slots: readonly LotSlot[]) =>
  [...slots]
    .sort((a, b) => a.position - b.position)
    .map((l) => `${l.lotNumber}:${l.quantity}`)
    .join(" ");

const scanAll = (boxQuantity: number, codes: string[]) =>
  codes.reduce<LotSlot[]>((acc, code) => lots(scanLotInto(acc, boxQuantity, ref(code))), []);

describe("scanLotInto", () => {
  it("gives the first lot every unit; it is the default lot", () => {
    expect(show(scanAll(3, ["A"]))).toBe("A:3");
    expect(scanAll(3, ["A"])[0]?.position).toBe(0);
  });

  it("gives a second lot one unit from the default", () => {
    expect(show(scanAll(3, ["A", "B"]))).toBe("A:2 B:1");
  });

  it("moves one more unit to a lot scanned again", () => {
    expect(show(scanAll(3, ["A", "B", "B"]))).toBe("A:1 B:2");
  });

  it("takes from the largest lot once the default has 1 left", () => {
    expect(show(scanAll(4, ["A", "B", "B", "B", "C"]))).toBe("A:1 B:2 C:1");
  });

  it("breaks a tie for largest by the earliest lot", () => {
    // A:1 B:2 C:2 → D takes from B, the earlier of the two.
    const start: LotSlot[] = [
      { ...ref("A"), quantity: 1, position: 0 },
      { ...ref("B"), quantity: 2, position: 1 },
      { ...ref("C"), quantity: 2, position: 2 },
    ];
    expect(show(lots(scanLotInto(start, 5, ref("D"))))).toBe("A:1 B:1 C:2 D:1");
  });

  it("re-scanning a lot never takes from itself", () => {
    // A:1 B:3: scanning B again has no other lot to give a unit.
    const start: LotSlot[] = [
      { ...ref("A"), quantity: 1, position: 0 },
      { ...ref("B"), quantity: 3, position: 1 },
    ];
    expect(scanLotInto(start, 4, ref("B"))).toEqual({ ok: false, reason: "allUnitsHaveLots" });
    // Re-scanning the default takes from the largest other lot.
    expect(show(lots(scanLotInto(start, 4, ref("A"))))).toBe("A:2 B:2");
  });

  it("refuses a scan once every unit has its own lot", () => {
    const full = scanAll(2, ["A", "B"]);
    expect(scanLotInto(full, 2, ref("C"))).toEqual({ ok: false, reason: "allUnitsHaveLots" });
    expect(scanLotInto(full, 2, ref("A"))).toEqual({ ok: false, reason: "allUnitsHaveLots" });
    expect(scanLotInto(scanAll(1, ["A"]), 1, ref("B"))).toEqual({
      ok: false,
      reason: "allUnitsHaveLots",
    });
  });

  it("matches a lot already on the line by its Lumexia id too", () => {
    const start: LotSlot[] = [
      { lotNumber: null, lumexiaLotId: "id-a", quantity: 2, position: 0 },
      { ...ref("B"), quantity: 1, position: 1 },
    ];
    const plan = lots(scanLotInto(start, 3, { lotNumber: null, lumexiaLotId: "id-b" }));
    expect(plan).toHaveLength(3);
    expect(lots(scanLotInto(start, 3, ref("B"))).map((l) => l.quantity)).toEqual([1, 2]);
  });

  it("keeps the ids of the lots it changes and doesn't touch its input", () => {
    const start: LotSlot[] = [{ id: "x", ...ref("A"), quantity: 3, position: 0 }];
    const plan = lots(scanLotInto(start, 3, ref("B")));
    expect(plan[0]).toMatchObject({ id: "x", quantity: 2 });
    expect(plan[1]?.id).toBeUndefined();
    expect(start[0]?.quantity).toBe(3);
  });
});

describe("addUnitsToLots / removeUnitsFromLots", () => {
  it("packing more units adds them to the default lot", () => {
    expect(show(addUnitsToLots(scanAll(3, ["A", "B"]), 2))).toBe("A:4 B:1");
    expect(addUnitsToLots([], 2)).toEqual([]);
  });

  it("unpacking takes from the default down to 1, then from the latest lot", () => {
    const start = scanAll(6, ["A", "B", "C", "C"]); // A:3 B:1 C:2
    expect(show(start)).toBe("A:3 B:1 C:2");
    expect(show(removeUnitsFromLots(start, 2))).toBe("A:1 B:1 C:2");
    expect(show(removeUnitsFromLots(start, 3))).toBe("A:1 B:1 C:1");
    expect(show(removeUnitsFromLots(start, 4))).toBe("A:1 B:1");
    expect(show(removeUnitsFromLots(start, 5))).toBe("A:1");
    expect(removeUnitsFromLots(start, 6)).toEqual([]);
  });
});

/** mulberry32: a small seeded generator, so a failing sequence can be replayed from its seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("split rule properties", () => {
  it("Σ lots never exceeds the box line, and equals it once any lot exists", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const random = rng(seed);
      const pick = (n: number) => Math.floor(random() * n);
      let quantity = 1 + pick(4);
      let slots: LotSlot[] = [];
      const steps: string[] = [];
      for (let step = 0; step < 40; step++) {
        const op = pick(3);
        if (op === 0) {
          const code = "ABCDE"[pick(5)] as string;
          steps.push(`scan ${code}`);
          const plan = scanLotInto(slots, quantity, ref(code));
          if (plan.ok) slots = plan.lots;
        } else if (op === 1) {
          const n = 1 + pick(3);
          steps.push(`pack ${n}`);
          quantity += n;
          slots = addUnitsToLots(slots, n);
        } else {
          const n = 1 + pick(quantity);
          steps.push(`unpack ${n}`);
          quantity -= n;
          slots = removeUnitsFromLots(slots, n);
          // The box line goes at 0 and its lots with it; the next pack starts a fresh one.
          if (quantity === 0) {
            quantity = 1;
            slots = [];
          }
        }
        const total = slots.reduce((sum, l) => sum + l.quantity, 0);
        const context = `seed ${seed}: ${steps.join(", ")} → ${show(slots)} of ${quantity}`;
        expect(total, context).toBeLessThanOrEqual(quantity);
        if (slots.length > 0) expect(total, context).toBe(quantity);
        expect(
          slots.every((l) => l.quantity > 0),
          context,
        ).toBe(true);
        expect(new Set(slots.map((l) => l.lotNumber)).size, context).toBe(slots.length);
      }
    }
  });
});
