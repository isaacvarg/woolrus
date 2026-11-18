import type { CsvExport } from "@woolrus/core";
import type { Role } from "@woolrus/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

// GET /api/reports/throughput.csv (SPEC-reporting "CSV exports", criteria 6 and 7): a session,
// then `report.read`; the tab's range and filters and the viewer's locale reach core. Core's own
// tests cover the rows.

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
vi.mock("@woolrus/core", async (original) => {
  const actual = await original<typeof import("@woolrus/core")>();
  return {
    ...actual,
    throughputCsv: (...args: Parameters<typeof actual.throughputCsv>) => {
      actual.assertCan(args[1], "report.read");
      return mocks.csv(args[2], args[3]);
    },
  };
});
vi.mock("@woolrus/db", async (original) => ({
  ...(await original<typeof import("@woolrus/db")>()),
  db: {},
}));

import { GET } from "./throughput.csv/route";

const get = (query = "") => GET(new Request(`http://woolrus/api/reports/throughput.csv${query}`));

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

describe("GET /api/reports/throughput.csv", () => {
  it("needs a session, then report.read", async () => {
    expect((await get()).status).toBe(401);
    for (const role of ["PICKER", "PACKER", "QA", "SHIPPER", "RATE_LAB"] as const) {
      mocks.roles = [role];
      expect((await get()).status).toBe(403);
    }
    expect(mocks.csv).not.toHaveBeenCalled();
    for (const roles of [["ADMIN"], ["PACKER", "REPORTS"]] as Role[][]) {
      mocks.roles = roles;
      const response = await get();
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
      expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="x.csv"');
    }
  });

  it("passes the range, the filters and the viewer's language", async () => {
    mocks.roles = ["ADMIN"];
    mocks.locale = "es";
    await get(
      "?from=2026-11-01&to=2026-11-07&timeZone=America/Chicago&stage=PACKING&person=system&preset=7d",
    );
    expect(mocks.csv).toHaveBeenCalledWith(
      {
        from: "2026-11-01",
        to: "2026-11-07",
        timeZone: "America/Chicago",
        stage: "PACKING",
        person: "system",
      },
      { locale: "es" },
    );
  });
});
