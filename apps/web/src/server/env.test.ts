import { describe, expect, it } from "vitest";
import { parseWarehouseTimeZone } from "./env";

describe("parseWarehouseTimeZone", () => {
  it("accepts an IANA zone name", () => {
    expect(parseWarehouseTimeZone("America/Los_Angeles")).toBe("America/Los_Angeles");
  });

  it("rejects a missing zone", () => {
    expect(() => parseWarehouseTimeZone(undefined)).toThrow(/WAREHOUSE_TIME_ZONE/);
    expect(() => parseWarehouseTimeZone("")).toThrow(/WAREHOUSE_TIME_ZONE/);
  });

  it("rejects a name that isn't a time zone", () => {
    expect(() => parseWarehouseTimeZone("Pacific Time")).toThrow(/WAREHOUSE_TIME_ZONE/);
  });
});
