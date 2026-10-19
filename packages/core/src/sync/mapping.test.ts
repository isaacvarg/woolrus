import { describe, expect, it } from "vitest";
import orders from "../adapters/woocommerce/__fixtures__/orders.json" with { type: "json" };
import products from "../adapters/woocommerce/__fixtures__/products.json" with { type: "json" };
import variations from "../adapters/woocommerce/__fixtures__/variations-12.json" with {
  type: "json",
};
import { StoreError } from "../adapters/woocommerce/errors";
import { parseOrder, parseProduct, parseVariation } from "../adapters/woocommerce/schemas";
import { mapOrder, mapProduct, mapVariation } from "./mapping";

// The dev store is set to lbs / in, as recorded in setting-*-unit.json.
const devUnits = { weight: "lbs", dimension: "in" } as const;

const order = (index: number, patch: Record<string, unknown> = {}) =>
  parseOrder({ ...orders[index], ...patch });
const product = (index: number, patch: Record<string, unknown> = {}) =>
  parseProduct({ ...products[index], ...patch });

describe("mapOrder", () => {
  it("maps a recorded order field by field", () => {
    const raw = orders[2];
    expect(mapOrder(parseOrder(raw))).toEqual({
      wooOrderId: 15,
      number: "15",
      wooStatus: "processing",
      currency: "USD",
      customerName: "Ana Lopez",
      customerEmail: "ana@example.test",
      shippingAddress: {
        name: "Ana Lopez",
        address1: "742 Evergreen Ter",
        city: "Springfield",
        state: "OR",
        postalCode: "97477",
        country: "US",
        phone: "5555550100",
      },
      billingAddress: {
        name: "Ana Lopez",
        address1: "742 Evergreen Ter",
        city: "Springfield",
        state: "OR",
        postalCode: "97477",
        country: "US",
        phone: "5555550100",
        email: "ana@example.test",
      },
      customerNote: null,
      paymentMethod: null,
      totalCents: 5400,
      shippingChargedCents: 600,
      shippingMethod: "Standard",
      refundedCents: 0,
      orderedAt: new Date("2026-10-14T21:04:28Z"),
      wooModifiedAt: new Date("2026-10-14T21:04:28Z"),
      rawPayload: raw,
      items: [
        {
          wooLineItemId: 1,
          wooProductId: 10,
          wooVariationId: null,
          bundleParentWooLineItemId: null,
          name: "Lavender Bar Soap",
          sku: "SOAP-LAV",
          quantity: 3,
          unitPriceCents: 800,
          imageUrl: null,
          attributes: [],
          metaData: [
            { key: "_reduced_stock", value: "3", displayKey: "_reduced_stock", displayValue: "3" },
          ],
        },
        {
          wooLineItemId: 2,
          wooProductId: 11,
          wooVariationId: null,
          bundleParentWooLineItemId: null,
          name: "Vitamin C Serum 1oz",
          sku: "SERUM-VC-1",
          quantity: 1,
          unitPriceCents: 2400,
          imageUrl: null,
          attributes: [],
          metaData: [
            { key: "_reduced_stock", value: "1", displayKey: "_reduced_stock", displayValue: "1" },
          ],
        },
      ],
    });
  });

  it("maps a variation line with its attributes, the note and the shipping charge", () => {
    const mapped = mapOrder(order(1));
    expect(mapped).toMatchObject({
      customerName: "Ben Okafor",
      customerNote: "Please gift wrap",
      shippingAddress: { address2: "Apt 4" },
      shippingChargedCents: 1800,
      shippingMethod: "Express",
      totalCents: 4600,
    });
    expect(mapped.shippingAddress).not.toHaveProperty("phone");
    expect(mapped.items).toEqual([
      expect.objectContaining({
        wooLineItemId: 4,
        wooProductId: 12,
        wooVariationId: 13,
        name: "Body Lotion - 8oz",
        unitPriceCents: 1400,
        attributes: [{ name: "Size", option: "8oz" }],
      }),
    ]);
  });

  it("sums shipping lines in cents and joins their titles", () => {
    const mapped = mapOrder(
      order(2, {
        shipping_lines: [
          { method_title: "Standard", total: "0.1" },
          { method_title: "Insurance", total: "0.2" },
        ],
      }),
    );
    expect(mapped.shippingChargedCents).toBe(30);
    expect(mapped.shippingMethod).toBe("Standard, Insurance");
    expect(mapOrder(order(2, { shipping_lines: [] }))).toMatchObject({
      shippingChargedCents: 0,
      shippingMethod: null,
    });
  });

  it("takes the store's shipping-discount fees off shipping charged, and no other fee", () => {
    // As on the production store: a fee line refunds all or part of the UPS charge (decision 8).
    const ups = (total: string) => [{ method_title: "UPS Ground", total }];
    const fee = (name: string, total: string) => ({ name, total, tax_status: "none" });

    const free = order(2, {
      shipping_lines: ups("107.19"),
      fee_lines: [fee("Free Shipping Discount", "-107.19")],
    });
    expect(mapOrder(free).shippingChargedCents).toBe(0);

    const courtesy = order(2, {
      shipping_lines: ups("26.90"),
      fee_lines: [fee("Courtesy Shipping Discount", "-8.07"), fee("Handling", "5.00")],
    });
    expect(mapOrder(courtesy).shippingChargedCents).toBe(1883);

    // A discount larger than the shipping charged never makes it negative.
    const over = order(2, {
      shipping_lines: ups("10.00"),
      fee_lines: [fee("Free Shipping Discount", "-12.00")],
    });
    expect(mapOrder(over).shippingChargedCents).toBe(0);
  });

  it("adds up refunds as a positive refunded total", () => {
    const mapped = mapOrder(
      order(2, {
        refunds: [
          { id: 90, reason: "", total: "-8.00" },
          { id: 91, reason: "", total: "-0.10" },
        ],
      }),
    );
    expect(mapped.refundedCents).toBe(810);
  });

  it("takes the customer name from billing when the shipping name is empty", () => {
    const emptyName = { ...orders[2]?.shipping, first_name: "", last_name: "" };
    expect(mapOrder(order(2, { shipping: emptyName })).customerName).toBe("Ana Lopez");
    expect(mapOrder(order(2, { shipping: { ...emptyName, last_name: "Solo" } })).customerName).toBe(
      "Solo",
    );
    const noBillingName = { ...orders[2]?.billing, first_name: "", last_name: "" };
    expect(mapOrder(order(2, { shipping: emptyName, billing: noBillingName })).customerName).toBe(
      "ana@example.test",
    );
  });

  it("rounds a sub-cent line price and leaves a deleted product's id null", () => {
    const line = { ...orders[2]?.line_items[0], product_id: 0, price: 8.333333 };
    expect(mapOrder(order(2, { line_items: [line] })).items[0]).toMatchObject({
      wooProductId: null,
      unitPriceCents: 833,
    });
  });

  it("links bundled lines to their bundle line through Product Bundles' bundled_by", () => {
    const base = orders[2]?.line_items[0];
    const lines = [
      { ...base, id: 20, bundled_by: "" },
      { ...base, id: 21, bundled_by: "20" },
      { ...base, id: 22, bundled_by: 20 },
    ];
    expect(
      mapOrder(order(2, { line_items: lines })).items.map((i) => i.bundleParentWooLineItemId),
    ).toEqual([null, 20, 20]);
  });

  it("keeps only displayable public meta as attributes", () => {
    const line = {
      ...orders[1]?.line_items[0],
      meta_data: [
        { id: 1, key: "size", value: "8oz", display_key: "Size", display_value: "8oz" },
        { id: 2, key: "_private", value: "x", display_key: "_private", display_value: "x" },
        { id: 3, key: "engraving", value: "J+K" },
        { id: 4, key: "pa_count", value: 3, display_key: "Count", display_value: 3 },
        { id: 5, key: "addons", value: { a: 1 }, display_key: "Add-ons", display_value: { a: 1 } },
      ],
    };
    expect(mapOrder(order(1, { line_items: [line] })).items[0]?.attributes).toEqual([
      { name: "Size", option: "8oz" },
      { name: "engraving", option: "J+K" },
      { name: "Count", option: "3" },
    ]);
  });

  it("fails as badResponse, naming the field, when an amount isn't a decimal", () => {
    const attempt = () => mapOrder(order(2, { total: "54,00" }));
    expect(attempt).toThrow(StoreError);
    expect(attempt).toThrow(/order 15: total/);
    expect(attempt).not.toThrow(/54,00/);
  });
});

describe("mapProduct", () => {
  it("maps recorded simple products with weights in ounces and dimensions in inches", () => {
    expect(mapProduct(product(1), devUnits)).toEqual({
      wooProductId: 11,
      type: "simple",
      name: "Vitamin C Serum 1oz",
      sku: "SERUM-VC-1",
      imageUrl: null,
      priceCents: 2400,
      weightOz: 4,
      lengthIn: 2,
      widthIn: 2,
      heightIn: 4,
      stockQuantity: 37,
      physical: true,
      rawPayload: products[1],
    });
    expect(mapProduct(product(2), devUnits)).toMatchObject({ weightOz: 4.8, stockQuantity: 117 });
  });

  it("maps a recorded variable product with nothing set to nulls", () => {
    expect(mapProduct(product(0), devUnits)).toMatchObject({
      wooProductId: 12,
      type: "variable",
      priceCents: 1400,
      weightOz: null,
      lengthIn: null,
      widthIn: null,
      heightIn: null,
      stockQuantity: null,
    });
  });

  it("converts metric store units", () => {
    const metric = product(1, {
      weight: "0.5",
      dimensions: { length: "10", width: "100", height: "" },
    });
    expect(mapProduct(metric, { weight: "kg", dimension: "cm" })).toMatchObject({
      weightOz: 17.64,
      lengthIn: 3.94,
      widthIn: 39.37,
      heightIn: null,
    });
    expect(mapProduct(metric, { weight: "g", dimension: "mm" })).toMatchObject({
      weightOz: 0.02,
      lengthIn: 0.39,
      widthIn: 3.94,
    });
  });

  it("marks virtual products as not physical", () => {
    expect(mapProduct(product(1, { virtual: true }), devUnits).physical).toBe(false);
  });

  it("reads the bin from _bin_location and the barcode from global_unique_id, only when sent", () => {
    const mapped = mapProduct(
      product(1, {
        global_unique_id: "0123456789012",
        meta_data: [{ id: 9, key: "_bin_location", value: " A-03-2 " }],
      }),
      devUnits,
    );
    expect(mapped).toMatchObject({ binLocation: "A-03-2", barcode: "0123456789012" });

    // Absent (not null): the upsert leaves the warehouse's own value alone.
    const blank = mapProduct(
      product(1, { meta_data: [{ id: 9, key: "_bin_location", value: "" }] }),
      devUnits,
    );
    expect(blank).not.toHaveProperty("binLocation");
    expect(blank).not.toHaveProperty("barcode");
  });
});

describe("mapVariation", () => {
  it("maps a recorded variation under its parent", () => {
    expect(mapVariation(12, parseVariation(variations[1]), devUnits)).toEqual({
      wooVariationId: 13,
      wooProductId: 12,
      name: "8oz",
      sku: "LOTION-8",
      attributes: [{ name: "Size", option: "8oz" }],
      imageUrl: null,
      priceCents: 1400,
      weightOz: 9.6,
      lengthIn: null,
      widthIn: null,
      heightIn: null,
      stockQuantity: null,
      rawPayload: variations[1],
    });
  });

  it("names a variation from its options when the store sends no name", () => {
    const unnamed = parseVariation({
      ...variations[0],
      name: "",
      attributes: [
        { id: 0, name: "Size", option: "16oz" },
        { id: 0, name: "Scent", option: "Rose" },
      ],
    });
    expect(mapVariation(12, unnamed, devUnits).name).toBe("16oz / Rose");
  });
});
