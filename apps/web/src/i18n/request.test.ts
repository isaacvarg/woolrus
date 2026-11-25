import { createFormatter } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";

// Vitest resolves next-intl's client build, where getRequestConfig throws; it's an identity wrapper.
vi.mock("next-intl/server", () => ({ getRequestConfig: <T>(fn: T) => fn }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/server/actor", () => ({ currentUser: async () => null }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function requestConfig() {
  const { default: getConfig } = await import("./request");
  return getConfig({ requestLocale: Promise.resolve(undefined) });
}

describe("i18n request config", () => {
  it("formats in the warehouse time zone, not the server's own", async () => {
    vi.stubEnv("TZ", "UTC");
    vi.stubEnv("WAREHOUSE_TIME_ZONE", "America/Los_Angeles");
    const config = await requestConfig();

    expect(config.timeZone).toBe("America/Los_Angeles");
    const format = createFormatter({ locale: "en", timeZone: config.timeZone });
    expect(format.dateTime(new Date("2026-11-25T17:18:00Z"), { timeStyle: "short" })).toBe(
      "9:18 AM",
    );
  });
});
