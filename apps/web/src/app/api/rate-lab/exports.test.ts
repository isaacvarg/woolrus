import type { Role } from "@woolrus/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The Rate Lab CSV routes (SPEC-rate-lab "Exports", criteria 14 and 15): a session, then the
// page's permission; a refusal is a status code. Core's own tests cover the rows.

const mocks = vi.hoisted(() => ({
  roles: null as Role[] | null,
  queryRaw: vi.fn(),
  findMany: vi.fn(),
  findUnique: vi.fn(),
}));

vi.mock("@/server/actor", () => ({
  resolveActor: async () =>
    mocks.roles && {
      actor: { userId: "u", roles: mocks.roles, stationId: null, requestId: "r" },
    },
}));
vi.mock("@woolrus/db", async (original) => ({
  ...(await original<typeof import("@woolrus/db")>()),
  db: {
    $queryRaw: mocks.queryRaw,
    shippingCarrier: { findMany: mocks.findMany },
    carrierService: { findMany: mocks.findMany },
    box: { findMany: mocks.findMany },
    rateLabRun: { findUnique: mocks.findUnique },
  },
}));

import { GET as realOrders } from "./real-orders/export.csv/route";
import { GET as run } from "./runs/[id]/export.csv/route";

const runId = "01a1a7e8-1159-7098-b4a5-fc9b8586869b";
const runExport = () =>
  run(new Request(`http://woolrus/api/rate-lab/runs/${runId}/export.csv`), {
    params: Promise.resolve({ id: runId }),
  });
const ordersExport = (query = "") =>
  realOrders(new Request(`http://woolrus/api/rate-lab/real-orders/export.csv${query}`));

beforeEach(() => {
  mocks.roles = null;
  mocks.queryRaw.mockReset().mockResolvedValue([]);
  mocks.findMany.mockReset().mockResolvedValue([]);
  mocks.findUnique.mockReset().mockResolvedValue(null);
});

describe("GET /api/rate-lab/runs/{id}/export.csv", () => {
  it("needs a session, then ratelab.use", async () => {
    expect((await runExport()).status).toBe(401);
    mocks.roles = ["SHIPPER"];
    expect((await runExport()).status).toBe(403);
    mocks.roles = ["PICKER", "RATE_LAB"];
    // Allowed through to the lookup: the run doesn't exist.
    expect((await runExport()).status).toBe(404);
    expect(mocks.findUnique).toHaveBeenCalled();
  });
});

describe("GET /api/rate-lab/real-orders/export.csv", () => {
  it("needs report.read, which the Rate Lab role alone doesn't give", async () => {
    expect((await ordersExport()).status).toBe(401);
    mocks.roles = ["RATE_LAB"];
    expect((await ordersExport()).status).toBe(403);
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it("downloads a UTF-8 CSV with a BOM for the dashboard's range, and refuses a bad one", async () => {
    mocks.roles = ["ADMIN"];
    const response = await ordersExport("?from=2026-10-01&to=2026-10-31&state=TX&includeFake=true");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="real-orders-2026-10-01-2026-10-31.csv"',
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(bytes.slice(3))).toMatch(/^Order,Package,.*,Reason\r\n$/);
    const values = mocks.queryRaw.mock.calls[0]?.slice(1);
    expect(values).toEqual(
      expect.arrayContaining([new Date("2026-10-01"), new Date("2026-11-01")]),
    );

    expect((await ordersExport("?from=2026-11-02&to=2026-11-01")).status).toBe(400);
  });
});
