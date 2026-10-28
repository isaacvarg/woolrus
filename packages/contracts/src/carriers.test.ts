import { describe, expect, it } from "vitest";
import { SetProviderCredentialsInput, UpdateProviderConfigInput } from "./carriers";

describe("SetProviderCredentialsInput", () => {
  it("trims each field and drops unknown ones, so nothing else reaches the encrypted blob", () => {
    expect(
      SetProviderCredentialsInput.parse({
        provider: "BRIDGE_SOURCE",
        credentials: { apiKey: "  key  ", customerId: " C-1 ", extra: "nope" },
      }),
    ).toEqual({ provider: "BRIDGE_SOURCE", credentials: { apiKey: "key", customerId: "C-1" } });
  });

  it("refuses a blank, missing or oversized field, and the other provider's fields", () => {
    const refused = [
      { provider: "SHIPSTATION", credentials: { apiKey: "   " } },
      { provider: "SHIPSTATION", credentials: { apiKey: "k".repeat(501) } },
      { provider: "BRIDGE_SOURCE", credentials: { apiKey: "key" } },
      { provider: "SHIPSTATION", credentials: {} },
      { provider: "UPS", credentials: { apiKey: "key" } },
    ];
    for (const input of refused) {
      expect(SetProviderCredentialsInput.safeParse(input).success, JSON.stringify(input)).toBe(
        false,
      );
    }
  });
});

describe("UpdateProviderConfigInput", () => {
  it("is Bridge Source only, with an https base URL or none", () => {
    expect(
      UpdateProviderConfigInput.safeParse({ provider: "BRIDGE_SOURCE", baseUrl: null }).success,
    ).toBe(true);
    expect(
      UpdateProviderConfigInput.safeParse({
        provider: "BRIDGE_SOURCE",
        baseUrl: "https://bs.example.com/restapi",
      }).success,
    ).toBe(true);
    for (const input of [
      { provider: "SHIPSTATION", baseUrl: "https://elsewhere.example.com" },
      { provider: "BRIDGE_SOURCE", baseUrl: "http://bs.example.com" },
      { provider: "BRIDGE_SOURCE", baseUrl: "https://user:pass@bs.example.com" },
    ]) {
      expect(UpdateProviderConfigInput.safeParse(input).success, JSON.stringify(input)).toBe(false);
    }
  });
});
