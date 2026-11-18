import type { CsvExport } from "@woolrus/core";
import type { Role } from "@woolrus/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The list and order-items CSV routes (SPEC-reporting "CSV exports", criteria 6 and 7): a session,
// then `report.read`; the screen's query parameters and the viewer's locale reach core. Core's
// own tests cover the rows.

const mocks = vi.hoisted(() => ({
  roles: null as Role[] | null,
  locale: "en",
  csv: vi.fn(),
}));

vi.mock("@/server/actor", () => ({
  resolveActor: async () =>
    mocks.roles && {
      actor: { userId: "u", roles: mocks.roles, stationId: null, requestId: "r" },
      user: { locale: mocks.locale },
    },
}));
// Each export runs for real up to its permission check; past it, the test hands back a file.
vi.mock("@woolrus/core", async (original) => {
  const actual = await original<typeof import("@woolrus/core")>();
  const wrap =
    (name: string) =>
    (...args: Parameters<typeof actual.ordersCsv>) => {
      actual.assertCan(args[1], "report.read");
      return mocks.csv(name, args[2], args[3]);
    };
  return {
    ...actual,
    ordersCsv: wrap("orders"),
    issuesCsv: wrap("issues"),
    voidsCsv: wrap("voids"),
    orderItemsCsv: wrap("orderItems"),
    cycleTimeCsv: wrap("cycleTime"),
  };
});
vi.mock("@woolrus/db", async (original) => ({
  ...(await original<typeof import("@woolrus/db")>()),
  db: {},
}));

import { GET as issues } from "../issues/export.csv/route";
import { GET as orders } from "../orders/export.csv/route";
import { GET as voids } from "../voids/export.csv/route";
import { GET as cycleTime } from "./cycle-time.csv/route";
import { GET as orderItems } from "./order-items.csv/route";

const routes = {
  "/api/orders/export.csv": orders,
  "/api/issues/export.csv": issues,
  "/api/voids/export.csv": voids,
  "/api/reports/order-items.csv": orderItems,
  "/api/reports/cycle-time.csv": cycleTime,
};
const get = (path: keyof typeof routes, query = "") =>
  routes[path](new Request(`http://woolrus${path}${query}`));

async function* none() {}

beforeEach(() => {
  mocks.roles = null;
  mocks.locale = "en";
  mocks.csv
    .mockReset()
    .mockImplementation(
      async (): Promise<CsvExport> => ({ filename: "x.csv", header: ["A"], rows: none() }),
    );
});

describe.each(Object.keys(routes) as (keyof typeof routes)[])("GET %s", (path) => {
  it("needs a session, then report.read", async () => {
    expect((await get(path)).status).toBe(401);
    for (const role of ["PICKER", "PACKER", "QA", "SHIPPER", "RATE_LAB"] as const) {
      mocks.roles = [role];
      expect((await get(path)).status).toBe(403);
    }
    expect(mocks.csv).not.toHaveBeenCalled();
    mocks.roles = ["PACKER", "REPORTS"];
    expect((await get(path)).status).toBe(200);
    mocks.roles = ["ADMIN"];
    const response = await get(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="x.csv"');
  });

  it("writes headers in the viewer's saved language", async () => {
    mocks.roles = ["ADMIN"];
    mocks.locale = "es";
    await get(path);
    expect(mocks.csv).toHaveBeenCalledWith(expect.any(String), expect.anything(), {
      locale: "es",
    });
  });
});

describe("query parameters", () => {
  beforeEach(() => {
    mocks.roles = ["ADMIN"];
  });

  it("passes the All orders filters and sort, with repeated statuses as a list", async () => {
    await get(
      "/api/orders/export.csv",
      "?search=maria&statuses=PACKING&statuses=QA&sort=number&dir=asc&timeZone=America/Chicago&page=3",
    );
    expect(mocks.csv).toHaveBeenCalledWith(
      "orders",
      {
        search: "maria",
        statuses: ["PACKING", "QA"],
        sort: "number",
        dir: "asc",
        timeZone: "America/Chicago",
      },
      expect.anything(),
    );
  });

  it("passes the Issues tab and filters", async () => {
    await get("/api/issues/export.csv", "?status=open&severity=MAJOR&type=WRONG_ITEM&timeZone=UTC");
    expect(mocks.csv).toHaveBeenCalledWith(
      "issues",
      { status: "open", severity: "MAJOR", type: "WRONG_ITEM", timeZone: "UTC" },
      expect.anything(),
    );
  });

  it("passes the Voids tab and search", async () => {
    await get("/api/voids/export.csv", "?status=resolved&search=4001");
    expect(mocks.csv).toHaveBeenCalledWith(
      "voids",
      { status: "resolved", search: "4001" },
      expect.anything(),
    );
  });

  it("passes the order-items range", async () => {
    await get("/api/reports/order-items.csv", "?from=2026-11-01&to=2026-11-07&timeZone=UTC");
    expect(mocks.csv).toHaveBeenCalledWith(
      "orderItems",
      { from: "2026-11-01", to: "2026-11-07", timeZone: "UTC" },
      expect.anything(),
    );
  });

  it("passes the cycle-time range", async () => {
    await get("/api/reports/cycle-time.csv", "?from=2026-11-01&to=2026-11-07&timeZone=UTC&x=1");
    expect(mocks.csv).toHaveBeenCalledWith(
      "cycleTime",
      { from: "2026-11-01", to: "2026-11-07", timeZone: "UTC" },
      expect.anything(),
    );
  });
});
