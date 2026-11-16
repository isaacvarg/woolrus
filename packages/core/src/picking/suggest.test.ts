import { describe, expect, it } from "vitest";
import { type SuggestionOrder, suggestBatches } from "./suggest";

// SPEC-picking A1, success criteria 17 and 19: the grouping is pure, so these need no database.

let n = 0;
/** An order in queue order (the caller sorts), with one line per product key, 1 unit unless given. */
function order(products: (string | [string, number])[], extra: Partial<SuggestionOrder> = {}) {
  n += 1;
  return {
    id: `order-${n}`,
    number: `${1000 + n}`,
    version: 1,
    orderedAt: new Date(2026, 10, 1, 0, n),
    lines: products.map((p) => {
      const [key, quantity] = typeof p === "string" ? [p, 1] : p;
      return { key, name: `Name of ${key}`, quantity };
    }),
    ...extra,
  } satisfies SuggestionOrder;
}

const limits = { maxOrders: 10, count: 3 };
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
    const [first] = suggestBatches([top, c, b1, b2], { maxOrders: 3, count: 3 });

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

    const suggestions = suggestBatches(orders, { maxOrders: 3, count: 3 });

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
