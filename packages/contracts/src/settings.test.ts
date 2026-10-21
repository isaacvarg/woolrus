import { describe, expect, it } from "vitest";
import { toFieldErrors } from "./base";
import { SetSecretInput, UpdateSettingsInput } from "./settings";

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
      claimExpiryMinutes: 30,
      pickBatchMaxOrders: 10,
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

  it("normalizes the state code to upper case", () => {
    const result = UpdateSettingsInput.parse({ shipFromAddress: { ...address, state: " tx " } });
    expect(result.shipFromAddress?.state).toBe("TX");
  });

  it("refuses a username or password in an integration URL", () => {
    // It would be stored and shown in plain text, outside the encrypted secrets.
    expect(fieldErrors({ wooStoreUrl: "https://ck_x:cs_y@shop.example.com" })).toEqual({
      wooStoreUrl: "errors.field.urlCredentials",
    });
    expect(fieldErrors({ lumexiaBaseUrl: "https://key@lumexia.example.com" })).toEqual({
      lumexiaBaseUrl: "errors.field.urlCredentials",
    });
  });

  it("caps integration URLs at 2048 characters and trims them", () => {
    const long = `https://shop.example.com/${"a".repeat(2049 - 25)}`;
    expect(long).toHaveLength(2049);
    expect(fieldErrors({ wooStoreUrl: long })).toEqual({ wooStoreUrl: "errors.field.tooBig" });
    expect(fieldErrors({ wooStoreUrl: long.slice(0, 2048) })).toEqual({});
    expect(
      UpdateSettingsInput.parse({ wooStoreUrl: " https://shop.example.com " }).wooStoreUrl,
    ).toBe("https://shop.example.com");
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
    ["claimExpiryMinutes", 4],
    ["claimExpiryMinutes", 481],
    ["claimExpiryMinutes", 7.5],
    ["pickBatchMaxOrders", 1],
    ["pickBatchMaxOrders", 51],
    ["pickBatchMaxOrders", 2.5],
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

describe("SetSecretInput", () => {
  function secretErrors(input: unknown) {
    const result = SetSecretInput.safeParse(input);
    return result.success ? {} : toFieldErrors(result.error.issues);
  }

  it.each([
    ["an empty value", "", "errors.field.required"],
    ["a value of only spaces", "   ", "errors.field.required"],
    ["a value over 500 characters", "x".repeat(501), "errors.field.tooBig"],
  ])("rejects %s", (_, value, key) => {
    expect(secretErrors({ name: "wooConsumerKey", value })).toEqual({ value: key });
  });

  it("accepts 500 characters and trims the value", () => {
    expect(
      SetSecretInput.parse({ name: "wooConsumerKey", value: "x".repeat(500) }).value,
    ).toHaveLength(500);
    expect(SetSecretInput.parse({ name: "wooConsumerKey", value: "  abc  " }).value).toBe("abc");
  });

  it("rejects an unknown secret name", () => {
    expect(Object.keys(secretErrors({ name: "nope", value: "abc" }))).toEqual(["name"]);
  });
});

describe("emailFrom", () => {
  it.each([
    "no-reply@example.com",
    "Woolrus <no-reply@example.com>",
    "  Woolrus Warehouse <ops@mail.example.com>  ",
  ])("accepts %j", (value) => {
    expect(fieldErrors({ emailFrom: value })).toEqual({});
  });

  it("trims the value and clears with null", () => {
    expect(UpdateSettingsInput.parse({ emailFrom: " a@example.com " }).emailFrom).toBe(
      "a@example.com",
    );
    expect(fieldErrors({ emailFrom: null })).toEqual({});
  });

  it.each([
    "",
    "not an address",
    "Woolrus no-reply@example.com",
    "Woolrus <no-reply@example.com",
    "<no-reply@example.com>",
    "Woolrus <a@example.com>, b@example.com",
    `${"x".repeat(250)}@example.com`,
  ])("rejects %j", (value) => {
    expect(Object.keys(fieldErrors({ emailFrom: value }))).toEqual(["emailFrom"]);
  });
});

describe("resendApiKey", () => {
  it("is a secret name", () => {
    expect(SetSecretInput.parse({ name: "resendApiKey", value: "re_123" }).name).toBe(
      "resendApiKey",
    );
  });
});
