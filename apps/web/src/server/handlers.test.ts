import { createLogger } from "@woolrus/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";

// REST at /api/v1 (handlers.ts): query strings arrive as text, so GET inputs must read "true",
// "50" and a lone or repeated id the way the RPC client's real booleans, numbers and arrays read.
// Each core call records its input and answers 404, so no output (or database) is needed.

const mocks = vi.hoisted(() => ({ inputs: [] as unknown[] }));

vi.mock("@/server/actor", () => ({
  resolveActor: async () => ({
    user: { id: "u" },
    actor: { userId: "u", roles: ["ADMIN"], stationId: null, requestId: "r" },
    station: null,
    idleLockAt: null,
  }),
  resolveStationDevice: async () => ({ kind: "none" }),
}));
vi.mock("@woolrus/core", async (original) => {
  const actual = await original<typeof import("@woolrus/core")>();
  const record = async (_db: unknown, _actor: unknown, input: unknown) => {
    mocks.inputs.push(input);
    throw new actual.AppError("NOT_FOUND", "errors.notFound");
  };
  return {
    ...actual,
    realOrders: record,
    labTrendGrid: record,
    labTrendSeries: record,
    labTrendsReport: record,
    listLabAddresses: record,
    listLabParcels: record,
    listLabGroups: record,
    listBoxes: record,
    listVoids: record,
    listIssues: record,
  };
});

import { openApiHandler } from "./handlers";

async function get(path: string) {
  const { response } = await openApiHandler.handle(new Request(`http://woolrus/api/v1${path}`), {
    prefix: "/api/v1",
    context: { headers: new Headers(), log: createLogger({ module: "test" }), trace: {} },
  });
  return { status: response?.status, input: mocks.inputs.at(-1) };
}

const a = "01a1a7e8-1159-7098-b4a5-fc9b8586869b";
const b = "01a1a7e8-1159-7098-b4a5-fc9b8586869c";

beforeEach(() => {
  mocks.inputs.length = 0;
});

describe("GET inputs over /api/v1", () => {
  it("reads booleans and numbers from the query string", async () => {
    const { status, input } = await get(
      "/rate-lab/real-orders?includeFake=true&alternativesLimit=50",
    );
    expect(status).toBe(404);
    expect(input).toMatchObject({ includeFake: true, alternativesLimit: 50 });
    expect((await get("/rate-lab/real-orders?includeFake=false")).input).toMatchObject({
      includeFake: false,
    });
    expect((await get("/rate-lab/real-orders?alternativesLimit=0")).input).toMatchObject({
      alternativesLimit: 0,
    });
  });

  it("refuses what isn't a boolean or a number", async () => {
    expect((await get("/rate-lab/real-orders?includeFake=yes")).status).toBe(400);
    expect((await get("/rate-lab/real-orders?alternativesLimit=many")).status).toBe(400);
    expect(mocks.inputs).toHaveLength(0);
  });

  it.each([
    ["/rate-lab/trends?includeFake=true", { includeFake: true }],
    [
      `/rate-lab/trends/series?addressId=${a}&parcelId=${b}&includeFake=true`,
      { includeFake: true },
    ],
    ["/rate-lab/trends/report?includeFake=true", { includeFake: true }],
    ["/rate-lab/addresses?includeArchived=true", { includeArchived: true }],
    ["/rate-lab/parcels?includeArchived=true", { includeArchived: true }],
    ["/rate-lab/groups?kind=ADDRESS&includeArchived=true", { includeArchived: true }],
    ["/boxes?includeArchived=true", { includeArchived: true }],
    ["/voids?limit=20", { limit: 20 }],
    ["/issues?limit=20", { limit: 20 }],
  ])("reads %s", async (path, expected) => {
    const { status, input } = await get(path);
    expect(status).toBe(404);
    expect(input).toMatchObject(expected);
  });

  it("reads one id, repeated ids and bracketed ids as a list", async () => {
    expect((await get(`/rate-lab/trends?carrierIds=${a}`)).input).toMatchObject({
      carrierIds: [a],
    });
    expect((await get(`/rate-lab/trends?carrierIds=${a}&carrierIds=${b}`)).input).toMatchObject({
      carrierIds: [a, b],
    });
    expect(
      (await get(`/rate-lab/trends?addressGroupIds[]=${a}&addressGroupIds[]=${b}`)).input,
    ).toMatchObject({ addressGroupIds: [a, b] });
    expect((await get(`/rate-lab/addresses?groupIds=${a}`)).input).toMatchObject({
      groupIds: [a],
    });
  });
});
