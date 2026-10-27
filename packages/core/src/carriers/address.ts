import type { ShipAddress } from "../adapters/shipping/provider";

// Ship-to resolution (FR-SHIP-03, SPEC-carriers "Ship-to and address validation"). Pure: the rate
// fetch stores what it returns, and an incomplete address never reaches a provider.

/** Without these a provider can't rate or ship, so none is asked. */
export const requiredShipToFields = ["name", "address1", "city", "postalCode", "country"] as const;
export type ShipToField = (typeof requiredShipToFields)[number];

export type ResolvedShipTo =
  | { kind: "complete"; address: ShipAddress }
  | { kind: "incomplete"; missing: ShipToField[] };

const fields = [
  "name",
  "company",
  "phone",
  "email",
  "address1",
  "address2",
  "city",
  "state",
  "postalCode",
  "country",
] as const satisfies readonly (keyof ShipAddress)[];

/** A stored address's text fields, trimmed; blank, missing or non-text ones are absent. */
function textFields(value: unknown): Partial<Record<keyof ShipAddress, string>> {
  if (typeof value !== "object" || value === null) return {};
  const out: Partial<Record<keyof ShipAddress, string>> = {};
  for (const field of fields) {
    const raw = (value as Record<string, unknown>)[field];
    const text = typeof raw === "string" ? raw.trim() : "";
    if (text) out[field] = text;
  }
  return out;
}

/** Who the parcel is for: each falls back to billing on its own. */
const contactFields = ["name", "company", "phone", "email"] as const;

/** Where the parcel goes. Taken from one address only, never mixed (decisions 2026-10-27). */
const locationFields = [
  "address1",
  "address2",
  "city",
  "state",
  "postalCode",
  "country",
] as const satisfies readonly (keyof ShipAddress)[];

const pick = (from: Partial<Record<keyof ShipAddress, string>>, keys: readonly string[]) =>
  Object.fromEntries(Object.entries(from).filter(([key]) => keys.includes(key)));

/**
 * The location as a whole from the shipping address, or from billing when shipping has none of it;
 * name, company, phone and email from shipping, else billing, field by field. Mixing locations
 * could put billing's apartment on the shipping street.
 */
export function resolveShipTo(order: {
  shippingAddress: unknown;
  billingAddress: unknown;
}): ResolvedShipTo {
  const shipping = textFields(order.shippingAddress);
  const billing = textFields(order.billingAddress);
  const hasLocation = locationFields.some((field) => shipping[field]);
  const merged: Partial<Record<keyof ShipAddress, string>> = {
    ...pick(billing, contactFields),
    ...pick(shipping, contactFields),
    ...pick(hasLocation ? shipping : billing, locationFields),
  };
  const missing = requiredShipToFields.filter((field) => !merged[field]);
  if (missing.length > 0) return { kind: "incomplete", missing };
  const address: ShipAddress = {
    ...merged,
    name: merged.name ?? "",
    address1: merged.address1 ?? "",
    city: merged.city ?? "",
    // Not every country has one; ShipStation and Bridge Source accept it empty there.
    state: merged.state ?? "",
    postalCode: merged.postalCode ?? "",
    country: (merged.country ?? "").toUpperCase(),
  };
  return { kind: "complete", address };
}
