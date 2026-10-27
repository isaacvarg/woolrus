import { describe, expect, it } from "vitest";
import { resolveShipTo } from "./address";

const full = {
  name: "Ana Ruiz",
  company: "Ruiz Co",
  phone: "512-555-0100",
  email: "ana@example.com",
  address1: "1 Main St",
  address2: "Suite 4",
  city: "Austin",
  state: "TX",
  postalCode: "78701",
  country: "US",
};

describe("resolveShipTo (FR-SHIP-03)", () => {
  it("takes the shipping address when it's complete", () => {
    expect(resolveShipTo({ shippingAddress: full, billingAddress: {} })).toEqual({
      kind: "complete",
      address: full,
    });
  });

  it("falls back to billing field by field, phone and email too", () => {
    const shipping = { name: "Ana Ruiz", address1: "1 Main St", city: "Austin", country: "US" };
    const billing = {
      name: "Billing Name",
      address1: "9 Other Rd",
      city: "Dallas",
      state: "TX",
      postalCode: "78701",
      phone: "512-555-0199",
      email: "billing@example.com",
      country: "MX",
    };
    expect(resolveShipTo({ shippingAddress: shipping, billingAddress: billing })).toEqual({
      kind: "complete",
      address: {
        name: "Ana Ruiz",
        address1: "1 Main St",
        city: "Austin",
        state: "TX",
        postalCode: "78701",
        phone: "512-555-0199",
        email: "billing@example.com",
        country: "US",
      },
    });
  });

  it("treats blank fields as missing and trims the rest", () => {
    const shipping = { ...full, city: "  ", postalCode: " 78701 ", country: "us" };
    expect(
      resolveShipTo({ shippingAddress: shipping, billingAddress: { city: "Dallas" } }),
    ).toEqual({ kind: "complete", address: { ...full, city: "Dallas", country: "US" } });
  });

  it("is incomplete without name, line 1, city, postal code or country", () => {
    expect(
      resolveShipTo({
        shippingAddress: { address1: "1 Main St", state: "TX" },
        billingAddress: { city: "Austin" },
      }),
    ).toEqual({ kind: "incomplete", missing: ["name", "postalCode", "country"] });
  });

  it("copes with addresses that aren't objects", () => {
    expect(resolveShipTo({ shippingAddress: null, billingAddress: "nope" })).toEqual({
      kind: "incomplete",
      missing: ["name", "address1", "city", "postalCode", "country"],
    });
  });

  it("leaves the state empty when neither address has one", () => {
    const { state: _state, ...noState } = full;
    expect(resolveShipTo({ shippingAddress: noState, billingAddress: {} })).toEqual({
      kind: "complete",
      address: { ...noState, state: "" },
    });
  });
});
