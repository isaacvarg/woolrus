import { describe, expect, it } from "vitest";
import { trackingProvider } from "./tracking-provider";

describe("trackingProvider", () => {
  it.each([
    ["usps", "USPS"],
    ["UPS", "UPS"],
    ["fedex", "FedEx"],
    ["dhl_express", "DHL Express"],
  ])("maps %s to AST's provider %s", (code, name) => {
    expect(trackingProvider(code, "ShipStation account", "123")).toMatchObject({
      name,
      custom: false,
    });
  });

  it("sends an unknown carrier as a custom provider named after its display name", () => {
    expect(trackingProvider("acme", " Acme Freight ", "AF1")).toEqual({
      name: "Acme Freight",
      link: null,
      custom: true,
    });
  });

  it("falls back to the carrier code, never a label provider's name", () => {
    expect(trackingProvider("acme", null, "AF1").name).toBe("acme");
  });
});
