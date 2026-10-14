import { describe, expect, it } from "vitest";
import { toFieldErrors } from "./base";
import { UpdateSettingsInput } from "./settings";

const address = {
  name: "Shipping Dept",
  phone: "555-123-4567",
  address1: "1 Warehouse Way",
  city: "Austin",
  state: "TX",
  postalCode: "78701",
  country: "US",
};

function fieldErrors(input: unknown) {
  const result = UpdateSettingsInput.safeParse(input);
  return result.success ? {} : toFieldErrors(result.error.issues);
}

describe("UpdateSettingsInput", () => {
  it("accepts a full, valid patch", () => {
    const patch = {
      shipFromAddress: { ...address, company: "Woolrus", email: "ship@example.com" },
      wooStoreUrl: "https://shop.example.com",
      lumexiaBaseUrl: "https://lumexia.example.com",
      syncIntervalMinutes: 5,
      stationIdleLockMinutes: 10,
      stageSlaMinutes: { PENDING: 240, QA: 60 },
      weightDisplay: "LB_DECIMAL",
      piiRetentionDays: 365,
      qaMustDifferFromPacker: true,
    };
    expect(UpdateSettingsInput.parse(patch)).toEqual(patch);
  });

  it("accepts an empty patch and clearing nullable fields", () => {
    expect(fieldErrors({})).toEqual({});
    expect(
      fieldErrors({ wooStoreUrl: null, lumexiaBaseUrl: null, piiRetentionDays: null }),
    ).toEqual({});
  });

  it("allows http only for localhost hosts", () => {
    expect(fieldErrors({ wooStoreUrl: "http://localhost:8090" })).toEqual({});
    expect(fieldErrors({ wooStoreUrl: "http://shop.localhost" })).toEqual({});
    expect(fieldErrors({ wooStoreUrl: "http://shop.example.com" })).toEqual({
      wooStoreUrl: "errors.field.urlHttps",
    });
    expect(fieldErrors({ lumexiaBaseUrl: "ftp://lumexia.example.com" })).toEqual({
      lumexiaBaseUrl: "errors.field.urlHttps",
    });
    expect(fieldErrors({ wooStoreUrl: "not a url" })).toEqual({
      wooStoreUrl: "errors.field.urlHttps",
    });
  });

  it.each([
    ["missing phone", { phone: undefined }, "shipFromAddress.phone"],
    ["missing name", { name: "" }, "shipFromAddress.name"],
    ["lowercase state", { state: "tx" }, "shipFromAddress.state"],
    ["3-letter state", { state: "TEX" }, "shipFromAddress.state"],
    ["bad ZIP", { postalCode: "7870" }, "shipFromAddress.postalCode"],
    ["non-US country", { country: "CA" }, "shipFromAddress.country"],
    ["bad email", { email: "nope" }, "shipFromAddress.email"],
  ])("rejects a ship-from address with %s", (_, change, field) => {
    expect(Object.keys(fieldErrors({ shipFromAddress: { ...address, ...change } }))).toEqual([
      field,
    ]);
  });

  it.each([
    ["syncIntervalMinutes", 0],
    ["syncIntervalMinutes", 61],
    ["syncIntervalMinutes", 1.5],
    ["stationIdleLockMinutes", 0],
    ["stationIdleLockMinutes", 121],
    ["piiRetentionDays", 29],
    ["piiRetentionDays", 3651],
    ["weightDisplay", "KG"],
    ["qaMustDifferFromPacker", "yes"],
  ])("rejects %s = %j", (field, value) => {
    expect(Object.keys(fieldErrors({ [field]: value }))).toEqual([field]);
  });

  it.each([
    [{ PENDING: 0 }, "stageSlaMinutes.PENDING"],
    [{ READY: 10_081 }, "stageSlaMinutes.READY"],
    [{ COMPLETED: 60 }, "stageSlaMinutes"],
  ])("rejects SLA thresholds %j", (sla, field) => {
    expect(Object.keys(fieldErrors({ stageSlaMinutes: sla }))).toEqual([field]);
  });
});
