import { describe, expect, it } from "vitest";
import {
  type DiffableOrder,
  diffOrder,
  hasChanges,
  isUntouched,
  type UntouchedSnapshot,
} from "./changes";

const address = {
  name: "Ana Lopez",
  address1: "742 Evergreen Ter",
  city: "Springfield",
  state: "OR",
  postalCode: "97477",
  country: "US",
};

const stored: DiffableOrder = {
  wooStatus: "processing",
  customerName: "Ana Lopez",
  customerEmail: "ana@example.test",
  shippingAddress: address,
  billingAddress: { ...address, email: "ana@example.test" },
  customerNote: null,
  shippingMethod: "Standard",
  refundedCents: 0,
  items: [
    { wooLineItemId: 1, name: "Lavender Bar Soap", sku: "SOAP-LAV", quantity: 3 },
    { wooLineItemId: 2, name: "Vitamin C Serum", sku: "SERUM-VC-1", quantity: 1 },
  ],
};

const incoming = (patch: Partial<DiffableOrder>): DiffableOrder => ({ ...stored, ...patch });

describe("diffOrder (FR-SYNC-10)", () => {
  it("finds nothing when only untracked fields (meta, payload) differ", () => {
    const diff = diffOrder(stored, incoming({}));
    expect(diff).toEqual({ lines: { added: [], removed: [], quantity: [] } });
    expect(hasChanges(diff)).toBe(false);
  });

  it("treats address keys in another order, or an absent vs. undefined key, as unchanged", () => {
    const { name, ...rest } = address;
    const diff = diffOrder(
      stored,
      incoming({ shippingAddress: { ...rest, name, company: undefined } }),
    );
    expect(hasChanges(diff)).toBe(false);
  });

  it.each([
    ["status", { wooStatus: "cancelled" }, { status: { from: "processing", to: "cancelled" } }],
    [
      "shipping address",
      { shippingAddress: { ...address, address1: "1 New St" } },
      { shippingAddress: { from: address, to: { ...address, address1: "1 New St" } } },
    ],
    [
      "billing address",
      { billingAddress: { ...address } },
      { billingAddress: { from: { ...address, email: "ana@example.test" }, to: address } },
    ],
    [
      "customer note",
      { customerNote: "Gift wrap" },
      { customerNote: { from: null, to: "Gift wrap" } },
    ],
    [
      "shipping method",
      { shippingMethod: "Express" },
      { shippingMethod: { from: "Standard", to: "Express" } },
    ],
    [
      "customer name",
      { customerName: "Ana L. Lopez" },
      {
        customer: {
          from: { name: "Ana Lopez", email: "ana@example.test" },
          to: { name: "Ana L. Lopez", email: "ana@example.test" },
        },
      },
    ],
    [
      "customer email",
      { customerEmail: null },
      {
        customer: {
          from: { name: "Ana Lopez", email: "ana@example.test" },
          to: { name: "Ana Lopez", email: null },
        },
      },
    ],
    ["refund", { refundedCents: 800 }, { refunds: { from: 0, to: 800 } }],
  ] as const)("tracks a %s change", (_, patch, expected) => {
    const diff = diffOrder(stored, incoming(patch as Partial<DiffableOrder>));
    expect(diff).toEqual({ ...expected, lines: { added: [], removed: [], quantity: [] } });
    expect(hasChanges(diff)).toBe(true);
  });

  it("tracks lines added, removed and re-quantified by their WooCommerce line id", () => {
    const diff = diffOrder(
      stored,
      incoming({
        items: [
          { wooLineItemId: 1, name: "Lavender Bar Soap", sku: "SOAP-LAV", quantity: 5 },
          { wooLineItemId: 3, name: "Body Lotion", sku: "LOTION", quantity: 2 },
        ],
      }),
    );

    expect(diff.lines).toEqual({
      added: [{ wooLineItemId: 3, name: "Body Lotion", sku: "LOTION", quantity: 2 }],
      removed: [{ wooLineItemId: 2, name: "Vitamin C Serum", sku: "SERUM-VC-1", quantity: 1 }],
      quantity: [{ wooLineItemId: 1, name: "Lavender Bar Soap", from: 3, to: 5 }],
    });
    expect(hasChanges(diff)).toBe(true);
  });

  it("ignores line order", () => {
    const diff = diffOrder(stored, incoming({ items: [...stored.items].reverse() }));
    expect(hasChanges(diff)).toBe(false);
  });
});

describe("isUntouched", () => {
  const now = new Date("2026-10-19T12:00:00Z");
  const untouched: UntouchedSnapshot = {
    status: "PENDING",
    claimedById: null,
    claimedAt: null,
    items: [{ pickedQuantity: 0 }, { pickedQuantity: 0 }],
    packages: 0,
    voids: 0,
    qualityIssues: 0,
    notes: 0,
  };
  const check = (patch: Partial<UntouchedSnapshot>) =>
    isUntouched({ ...untouched, ...patch }, 30, now);

  it("is true for a pending order nobody has started", () => {
    expect(check({})).toBe(true);
  });

  it("is true when the only claim has expired", () => {
    expect(check({ claimedById: "u1", claimedAt: new Date("2026-10-19T11:00:00Z") })).toBe(true);
  });

  it.each([
    ["not pending", { status: "PICKING" }],
    ["on hold", { status: "ON_HOLD" }],
    ["live claim", { claimedById: "u1", claimedAt: new Date("2026-10-19T11:45:00Z") }],
    ["a line picked", { items: [{ pickedQuantity: 0 }, { pickedQuantity: 1 }] }],
    ["a package", { packages: 1 }],
    ["a void", { voids: 1 }],
    ["a quality issue", { qualityIssues: 1 }],
    ["a note", { notes: 1 }],
  ] as const)("is false with %s alone", (_, patch) => {
    expect(check(patch as Partial<UntouchedSnapshot>)).toBe(false);
  });
});
