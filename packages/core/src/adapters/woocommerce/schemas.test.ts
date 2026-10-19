import { describe, expect, it } from "vitest";
import orders from "./__fixtures__/orders.json" with { type: "json" };
import products from "./__fixtures__/products.json" with { type: "json" };
import variations from "./__fixtures__/variations-12.json" with { type: "json" };
import { parseOrder, parseProduct, parseVariation } from "./schemas";

// Fixtures are recorded from the dev store (:8090); see __fixtures__/README.md.

describe("WooCommerce response schemas", () => {
  it("parses every recorded order and keeps the raw object whole", () => {
    const parsed = orders.map(parseOrder);
    expect(parsed.map((o) => [o.id, o.status])).toEqual([
      [17, "on-hold"],
      [16, "processing"],
      [15, "processing"],
    ]);

    const order = parsed[2];
    expect(order).toMatchObject({
      id: 15,
      number: "15",
      currency: "USD",
      total: "54.00",
      customerNote: null,
      paymentMethodTitle: null,
      shipping: { firstName: "Ana", lastName: "Lopez", company: null, country: "US" },
      billing: { email: "ana@example.test" },
      shippingLines: [{ methodTitle: "Standard", total: "6.00" }],
      refunds: [],
    });
    // Woo sends GMT timestamps without a zone designator.
    expect(order?.dateCreatedGmt.toISOString()).toBe("2026-10-14T21:04:28.000Z");
    expect(order?.raw).toBe(orders[2]);
  });

  it("normalises line items: numeric price as a decimal string, empty strings as null", () => {
    const line = parseOrder(orders[2]).lineItems[0];
    expect(line).toMatchObject({
      id: 1,
      productId: 10,
      variationId: 0,
      name: "Lavender Bar Soap",
      sku: "SOAP-LAV",
      quantity: 3,
      price: "8",
      total: "24.00",
      imageSrc: null,
    });
    expect(line?.metaData[0]).toMatchObject({ key: "_reduced_stock", displayValue: "3" });
  });

  it("parses products and variations, with empty weights and dimensions as null", () => {
    const parsed = products.map(parseProduct);
    expect(parsed.map((p) => [p.id, p.type])).toEqual([
      [12, "variable"],
      [11, "simple"],
      [10, "simple"],
    ]);
    expect(parsed[0]).toMatchObject({ weight: null, dimensions: { length: null } });
    expect(parsed[1]).toMatchObject({
      weight: "0.25",
      dimensions: { length: "2", width: "2", height: "4" },
      virtual: false,
    });

    const variation = parseVariation(variations[0]);
    expect(variation).toMatchObject({
      id: 14,
      sku: "LOTION-16",
      weight: "1.1",
      imageSrc: null,
      attributes: [{ name: "Size", option: "16oz" }],
    });
    expect(variation.raw).toBe(variations[0]);
  });

  it("rejects a payload missing a field we rely on", () => {
    const { id: _id, ...noId } = orders[0] as Record<string, unknown>;
    expect(() => parseOrder(noId)).toThrow();
  });
});
