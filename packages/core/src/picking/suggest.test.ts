import { describe, expect, it } from "vitest";
import { type SuggestionOrder, suggestBatches } from "./suggest";

// SPEC-picking A1, success criteria 17 and 19: the grouping is pure, so these need no database.

let n = 0;
/**
 * An order in queue order (the caller sorts), with one line per product key, 1 unit unless given.
 * A line's product weighs 1 lb a unit unless a third element gives its ounces (null: no weight).
 */
function order(
  products: (string | [string, number] | [string, number, number | null])[],
  extra: Partial<SuggestionOrder> = {},
): SuggestionOrder {
  n += 1;
  return {
    id: `order-${n}`,
    number: `${1000 + n}`,
    version: 1,
    orderedAt: new Date(2026, 10, 1, 0, n),
    lines: products.map((p) => {
      const [key, quantity = 1, productWeightOz = 16] = typeof p === "string" ? [p] : p;
      return { key, name: `Name of ${key}`, quantity, productWeightOz, variationWeightOz: null };
    }),
    ...extra,
  };
}

const limits = { maxOrders: 10, count: 3, maxWeightOz: null };
const ids = (s: { orders: { id: string }[] }) => s.orders.map((o) => o.id);

describe("suggestBatches", () => {
  it("starts from the top order and adds the orders that share the most with it", () => {
    const top = order(["gallon", "soap"]);
    const one = order(["gallon"]);
    const none = order(["candle"]);
    const two = order(["gallon", "soap"]);

    const [first] = suggestBatches([top, one, none, two], limits);

    // `two` shares more than `one`, so it joins first, but the card lists orders in queue order.
    expect(ids(first as never)).toEqual([top.id, one.id, two.id]);
  });

  it("takes the start from the caller's queue order, so priority beats age", () => {
    // The caller sorts priority desc, then oldest: an urgent newer order comes first.
    const urgent = order(["soap"], { orderedAt: new Date(2026, 10, 5) });
    const older = order(["soap"], { orderedAt: new Date(2026, 10, 1) });

    const [first] = suggestBatches([urgent, older], limits);

    expect(first?.orders[0]?.id).toBe(urgent.id);
    expect(first?.oldest.number).toBe(older.number);
  });

  it("breaks ties by queue order and grows against everything picked so far", () => {
    const top = order(["a"]);
    const b1 = order(["a", "b"]);
    const b2 = order(["a", "b"]);
    const c = order(["b", "c"]);

    // b1 and b2 tie on "a"; b1 is first. Then b2 shares a and b, c only b: b2 before c.
    const [first] = suggestBatches([top, c, b1, b2], { maxOrders: 3, count: 3, maxWeightOz: null });

    expect(ids(first as never)).toEqual([top.id, b1.id, b2.id]);
  });

  it("never adds an order that shares nothing", () => {
    const top = order(["a"]);
    const other = order(["z"]);
    const match = order(["a"]);

    const suggestions = suggestBatches([top, other, match], limits);

    expect(suggestions.map(ids)).toEqual([[top.id, match.id]]);
  });

  it("stops at maxOrders, never repeats an order and returns at most `count`", () => {
    const orders = Array.from({ length: 12 }, () => order(["gallon"]));

    const suggestions = suggestBatches(orders, { maxOrders: 3, count: 3, maxWeightOz: null });

    expect(suggestions.map((s) => s.orders.length)).toEqual([3, 3, 3]);
    const all = suggestions.flatMap(ids);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toEqual(orders.slice(0, 9).map((o) => o.id));
  });

  it("keeps a lone top order as a one-order first card", () => {
    const top = order(["alone"]);
    const a = order(["x"]);
    const b = order(["x"]);

    const suggestions = suggestBatches([top, a, b], limits);

    expect(suggestions.map(ids)).toEqual([[top.id], [a.id, b.id]]);
  });

  it("drops a later one-order suggestion and carries on with the next order", () => {
    const top = order(["x"]);
    const mate = order(["x"]);
    const lonely = order(["y"]);
    const c = order(["z"]);
    const d = order(["z"]);

    const suggestions = suggestBatches([top, mate, lonely, c, d], limits);

    expect(suggestions.map(ids)).toEqual([
      [top.id, mate.id],
      [c.id, d.id],
    ]);
  });

  it("counts units, stops, the oldest order and the most shared products", () => {
    const top = order([["gallon", 2], "soap", "jar"], { orderedAt: new Date(2026, 10, 3) });
    const b = order([["gallon", 3], "soap"], { orderedAt: new Date(2026, 10, 1) });
    const c = order(["gallon", "lid"], { orderedAt: new Date(2026, 10, 2) });

    const [first] = suggestBatches([top, b, c], limits);

    expect(first).toMatchObject({
      units: 2 + 1 + 1 + 3 + 1 + 1 + 1,
      stops: 4,
      oldest: { number: b.number, orderedAt: b.orderedAt },
      shared: [
        { key: "gallon", name: "Name of gallon", units: 6, orders: 3 },
        { key: "soap", name: "Name of soap", units: 2, orders: 2 },
      ],
    });
    expect(first?.orders).toEqual(
      [top, b, c].map((o) => ({ id: o.id, number: o.number, version: 1 })),
    );
  });

  it("lists at most three shared products, most orders first, then most units", () => {
    const top = order(["a", "b", "c", "d"]);
    const two = order(["a", ["b", 5], "c", "d"]);
    const three = order(["a", "d"]);

    const [first] = suggestBatches([top, two, three], limits);

    expect(first?.shared.map((s) => s.key)).toEqual(["a", "d", "b"]);
  });

  it("counts a product on two lines of one order once per order", () => {
    const top = order(["gallon", "gallon"]);
    const other = order(["gallon"]);

    const [first] = suggestBatches([top, other], limits);

    expect(first).toMatchObject({ stops: 1, units: 3, shared: [{ units: 3, orders: 2 }] });
  });

  it("gives the same suggestions for the same input", () => {
    const orders = [order(["a", "b"]), order(["b"]), order(["a"]), order(["c"]), order(["c", "a"])];

    expect(suggestBatches(orders, limits)).toEqual(suggestBatches(orders, limits));
  });

  it("suggests nothing for no orders", () => {
    expect(suggestBatches([], limits)).toEqual([]);
  });
});

// SPEC-picking A1, success criterion 18.
describe("suggestBatches weight", () => {
  const lb = (pounds: number) => pounds * 16;
  const at50lb = { ...limits, maxWeightOz: lb(50) };

  it("skips an order that would go over and takes a lighter match instead", () => {
    const top = order([["gallon", 1, lb(20)]]);
    const heavy = order([
      ["gallon", 1, lb(20)],
      ["pail", 1, lb(25)],
    ]);
    const light = order([["gallon", 1, lb(20)]]);

    const [first] = suggestBatches([top, heavy, light], at50lb);

    // heavy shares as much as light and comes first in the queue, but 20 + 45 lb is over 50.
    expect(ids(first as never)).toEqual([top.id, light.id]);
    expect(first).toMatchObject({ weightOz: lb(40), missingWeightCount: 0, overWeight: false });
  });

  it("lets a suggestion reach the limit exactly", () => {
    const top = order([["gallon", 1, lb(25)]]);
    const mate = order([["gallon", 1, lb(25)]]);

    const [first] = suggestBatches([top, mate], at50lb);

    expect(ids(first as never)).toEqual([top.id, mate.id]);
  });

  it("makes an order over the limit by itself a one-order overWeight card, even a later one", () => {
    const top = order([["gallon", 1, lb(10)]]);
    const mate = order([["gallon", 1, lb(10)]]);
    const pallet = order([["gallon", 3, lb(20)]]);
    const c = order(["z"]);
    const d = order(["z"]);

    const suggestions = suggestBatches([top, mate, pallet, c, d], at50lb);

    expect(suggestions.map(ids)).toEqual([[top.id, mate.id], [pallet.id], [c.id, d.id]]);
    expect(suggestions.map((s) => s.overWeight)).toEqual([false, true, false]);
    expect(suggestions[1]?.weightOz).toBe(lb(60));
  });

  it("adds nothing to an order over the limit by itself", () => {
    const top = order([["pail", 2, lb(45)]]);
    const mate = order([["pail", 1, lb(1)]]);

    const suggestions = suggestBatches([top, mate], at50lb);

    expect(suggestions.map(ids)).toEqual([[top.id]]);
    expect(suggestions[0]?.overWeight).toBe(true);
  });

  it("counts a line without a weight as 0 and reports it as missing", () => {
    const top = order([
      ["gallon", 2, lb(10)],
      ["mystery", 3, null],
    ]);
    const mate = order([["mystery", 1, null]]);

    const [first] = suggestBatches([top, mate], at50lb);

    expect(first).toMatchObject({ weightOz: lb(20), missingWeightCount: 2 });
  });

  it("uses a variation's weight before its product's", () => {
    const top = order([]);
    top.lines.push(
      { key: "v1", name: "Red", quantity: 2, variationWeightOz: 100, productWeightOz: 5 },
      { key: "v2", name: "Blue", quantity: 1, variationWeightOz: null, productWeightOz: 5 },
    );

    const [first] = suggestBatches([top], limits);

    expect(first).toMatchObject({ weightOz: 205, missingWeightCount: 0 });
  });

  it("never stops an order joining when the limit is off", () => {
    const orders = Array.from({ length: 4 }, () => order([["pail", 1, lb(400)]]));

    const [first] = suggestBatches(orders, limits);

    expect(ids(first as never)).toEqual(orders.map((o) => o.id));
    expect(first).toMatchObject({ weightOz: lb(1600), overWeight: false });
  });
});
