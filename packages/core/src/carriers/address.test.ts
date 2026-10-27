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

  const billing = {
    name: "Billing Name",
    company: "Billing Co",
    phone: "512-555-0199",
    email: "billing@example.com",
    address1: "9 Other Rd",
    address2: "Apt 9",
    city: "Dallas",
    state: "TX",
    postalCode: "75201",
    country: "MX",
  };

  it("falls back to billing field by field for name, company, phone and email", () => {
    const { company: _c, phone: _p, email: _e, ...shipping } = full;
    expect(resolveShipTo({ shippingAddress: shipping, billingAddress: billing })).toEqual({
      kind: "complete",
      address: {
        ...shipping,
        company: "Billing Co",
        phone: "512-555-0199",
        email: "billing@example.com",
      },
    });
  });

  it("never mixes billing's location into a shipping address that has one", () => {
    // Billing's apartment on the shipping street would send the parcel to a door that isn't there.
    const { address2: _a, ...shipping } = full;
    expect(resolveShipTo({ shippingAddress: shipping, billingAddress: billing })).toEqual({
      kind: "complete",
      address: shipping,
    });
  });

  it("is incomplete rather than borrowing billing's city or postal code for a partial location", () => {
    const shipping = { name: "Ana Ruiz", address1: "1 Main St", city: "Austin", country: "US" };
    expect(resolveShipTo({ shippingAddress: shipping, billingAddress: billing })).toEqual({
      kind: "incomplete",
      missing: ["postalCode"],
    });
  });

  it("takes the whole location from billing when shipping has none of it", () => {
    expect(
      resolveShipTo({ shippingAddress: { name: "Ana Ruiz" }, billingAddress: billing }),
    ).toEqual({
      kind: "complete",
      address: { ...billing, name: "Ana Ruiz", country: "MX" },
    });
  });

  it("treats blank fields as missing and trims the rest", () => {
    const shipping = { ...full, postalCode: " 78701 ", country: "us" };
    expect(resolveShipTo({ shippingAddress: shipping, billingAddress: {} })).toEqual({
      kind: "complete",
      address: { ...full, country: "US" },
    });
    // Blank lines don't count as a location: billing's is used whole.
    const blank = { name: "Ana Ruiz", address1: "  ", city: "", country: " " };
    expect(resolveShipTo({ shippingAddress: blank, billingAddress: billing })).toMatchObject({
      kind: "complete",
      address: { address1: "9 Other Rd", city: "Dallas", country: "MX" },
    });
  });

  it("is incomplete without name, line 1, city, postal code or country", () => {
    expect(
      resolveShipTo({
        shippingAddress: { address1: "1 Main St", state: "TX" },
        billingAddress: { city: "Austin" },
      }),
    ).toEqual({ kind: "incomplete", missing: ["name", "city", "postalCode", "country"] });
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
