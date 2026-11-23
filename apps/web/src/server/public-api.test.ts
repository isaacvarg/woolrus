import { createLogger } from "@woolrus/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The one public procedure, redeeming a station setup code (SPEC-identity A3), over /api/v1: it
// has no cookie for SameSite to protect, so it refuses cross-site browser requests itself, and it
// refuses a device that already is a station before the code is used.

const mocks = vi.hoisted(() => ({
  device: { kind: "none" } as { kind: string; station?: unknown },
  redeemed: [] as string[],
}));

vi.mock("@/server/actor", () => ({
  resolveActor: async () => null,
  resolveStationDevice: async () => mocks.device,
}));
vi.mock("@/server/auth", () => ({
  appOrigin: () => "https://woolrus.example",
  auth: () => ({ api: { getSession: async () => null } }),
}));
vi.mock("@/server/station-cookie", async (original) => ({
  ...(await original<typeof import("./station-cookie")>()),
  stationCookie: (token: string) => `woolrus_station=${token}; Path=/; HttpOnly`,
}));
vi.mock("@woolrus/core", async (original) => ({
  ...(await original<typeof import("@woolrus/core")>()),
  redeemStationSetupCode: async (_db: unknown, { code }: { code: string }) => {
    mocks.redeemed.push(code);
    return { station: { id: "01a1a7e8-1159-7098-b4a5-fc9b8586869b", name: "Pack 3" }, token: "t" };
  },
}));

import { openApiHandler } from "./handlers";

async function redeem(headers: Record<string, string>, body: string) {
  const { response } = await openApiHandler.handle(
    new Request("https://woolrus.example/api/v1/station/setup", { method: "POST", headers, body }),
    {
      prefix: "/api/v1",
      context: { headers: new Headers(headers), log: createLogger({ module: "test" }), trace: {} },
    },
  );
  return { status: response?.status, setCookie: response?.headers.get("set-cookie") ?? "" };
}

const json = { "content-type": "application/json" };
const body = JSON.stringify({ code: "7KQ4M-XD2RA" });

beforeEach(() => {
  mocks.device = { kind: "none" };
  mocks.redeemed.length = 0;
});

describe("station.redeemSetupCode", () => {
  it("redeems from the app's own page and sets the station cookie", async () => {
    const { status, setCookie } = await redeem({ ...json, "sec-fetch-site": "same-origin" }, body);
    expect(status).toBe(200);
    expect(mocks.redeemed).toEqual(["7KQ4M-XD2RA"]);
    expect(setCookie).toContain("woolrus_station=t");
  });

  it("refuses a cross-site form post without using the code", async () => {
    const { status, setCookie } = await redeem(
      {
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "cross-site",
        origin: "https://evil.example",
      },
      "code=7KQ4M-XD2RA",
    );
    expect(status).toBe(403);
    expect(mocks.redeemed).toEqual([]);
    expect(setCookie).toBe("");
  });

  it("falls back to Origin when the browser sends no Sec-Fetch-Site", async () => {
    expect((await redeem({ ...json, origin: "https://evil.example" }, body)).status).toBe(403);
    expect((await redeem({ ...json, origin: "https://woolrus.example" }, body)).status).toBe(200);
    expect(mocks.redeemed).toEqual(["7KQ4M-XD2RA"]);
  });

  it("refuses a device that already is a station, leaving the code unused", async () => {
    mocks.device = { kind: "station", station: { id: "s" } };
    const { status, setCookie } = await redeem({ ...json, "sec-fetch-site": "same-origin" }, body);
    expect(status).toBe(409);
    expect(mocks.redeemed).toEqual([]);
    expect(setCookie).toBe("");
  });
});
