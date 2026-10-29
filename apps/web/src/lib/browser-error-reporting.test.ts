import { describe, expect, it } from "vitest";
import { initBrowserErrorReporting } from "./browser-error-reporting";

describe("browser error reporting", () => {
  it("isn't initialised without a DSN", () => {
    expect(initBrowserErrorReporting({ userId: "u-1" })).toBe(false);
    expect(initBrowserErrorReporting({ dsn: "" })).toBe(false);
  });
});
