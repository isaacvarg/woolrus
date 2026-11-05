import { AppError, type AppErrorKind, type CsvCell, type CsvExport } from "@woolrus/core";
import { Prisma, type Role } from "@woolrus/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The Rate Lab CSV routes (SPEC-rate-lab "Exports", criteria 14 and 15): a session, then the
// page's permission; a refusal is a status code. Core's own tests cover the rows.

const mocks = vi.hoisted(() => ({
  roles: null as Role[] | null,
  queryRaw: vi.fn(),
  findMany: vi.fn(),
  findUnique: vi.fn(),
  logError: vi.fn(),
  labRunCsv: vi.fn(),
}));

vi.mock("@/server/actor", () => ({
  resolveActor: async () =>
    mocks.roles && {
      actor: { userId: "u", roles: mocks.roles, stationId: null, requestId: "r" },
    },
}));
vi.mock("@woolrus/logger", async (original) => {
  const actual = await original<typeof import("@woolrus/logger")>();
  return {
    ...actual,
    createLogger: (bindings: Record<string, unknown>) =>
      bindings.module === "csv-export"
        ? Object.assign(actual.createLogger(bindings), { error: mocks.logError })
        : actual.createLogger(bindings),
  };
});
// The run export reads a whole run through getLabRun, which core's tests cover: the real one runs
// unless a test hands the route a ready export.
vi.mock("@woolrus/core", async (original) => {
  const actual = await original<typeof import("@woolrus/core")>();
  return { ...actual, labRunCsv: mocks.labRunCsv };
});
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

import { serveCsv } from "@/server/csv-export";
import { GET as realOrders } from "./real-orders/export.csv/route";
import { GET as run } from "./runs/[id]/export.csv/route";

const runId = "01a1a7e8-1159-7098-b4a5-fc9b8586869b";
const runExport = () =>
  run(new Request(`http://woolrus/api/rate-lab/runs/${runId}/export.csv`), {
    params: Promise.resolve({ id: runId }),
  });
const ordersExport = (query = "") =>
  realOrders(new Request(`http://woolrus/api/rate-lab/real-orders/export.csv${query}`));

async function* each(rows: (readonly CsvCell[])[]) {
  yield* rows;
}
/** The file's text after the BOM. */
const text = async (response: Response) =>
  new TextDecoder().decode(new Uint8Array(await response.arrayBuffer()).slice(3));

beforeEach(async () => {
  mocks.roles = null;
  mocks.queryRaw.mockReset().mockResolvedValue([]);
  mocks.findMany.mockReset().mockResolvedValue([]);
  mocks.findUnique.mockReset().mockResolvedValue(null);
  mocks.logError.mockReset();
  const actual = await vi.importActual<typeof import("@woolrus/core")>("@woolrus/core");
  mocks.labRunCsv.mockReset().mockImplementation(actual.labRunCsv);
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

  it("downloads the run's quotes as a same-origin CSV", async () => {
    mocks.roles = ["RATE_LAB"];
    mocks.labRunCsv.mockResolvedValueOnce({
      filename: "rate-lab-run-2026-11-01-01a1a7e8.csv",
      header: ["Run", "Amount"],
      rows: each([[runId, 7.5]]),
    } satisfies CsvExport);
    const response = await runExport();
    expect(response.status).toBe(200);
    expect(mocks.labRunCsv).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      id: runId,
    });
    expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="rate-lab-run-2026-11-01-01a1a7e8.csv"',
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(await text(response)).toBe(`Run,Amount\r\n${runId},7.5\r\n`);
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
    // At most a year: the export reads every quote of the range.
    expect((await ordersExport("?from=2025-01-01&to=2026-10-31")).status).toBe(400);
  });

  it("reads includeFake as the report pages write it, 1 or true", async () => {
    mocks.roles = ["ADMIN"];
    // The query's last part leaves fake quotes out, or is empty when they're asked for.
    const fakeFilter = async (query: string) => {
      mocks.queryRaw.mockClear();
      await (await ordersExport(query)).arrayBuffer();
      return mocks.queryRaw.mock.calls[0]?.at(-1);
    };
    expect(await fakeFilter("?includeFake=true")).toBe(Prisma.empty);
    expect(await fakeFilter("?includeFake=1")).toBe(Prisma.empty);
    expect(await fakeFilter("")).not.toBe(Prisma.empty);
    expect(await fakeFilter("?includeFake=0")).not.toBe(Prisma.empty);
  });
});

describe("serveCsv", () => {
  const path = "/api/rate-lab/x/export.csv";
  const serve = (load: () => Promise<CsvExport>) =>
    serveCsv(new Request(`http://woolrus${path}`), load);

  it.each([
    ["BAD_REQUEST", 400],
    ["UNAUTHORIZED", 401],
    ["FORBIDDEN", 403],
    ["NOT_FOUND", 404],
    ["CONFLICT", 409],
  ] satisfies [AppErrorKind, number][])("answers a %s refusal with %i", async (kind, status) => {
    mocks.roles = ["ADMIN"];
    const response = await serve(async () => {
      throw new AppError(kind, "errors.validation");
    });
    expect(response.status).toBe(status);
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it("logs an unexpected failure before the download and answers 503", async () => {
    mocks.roles = ["ADMIN"];
    const err = new Error("db down");
    expect((await serve(() => Promise.reject(err))).status).toBe(503);
    expect(mocks.logError).toHaveBeenCalledWith({ err, path }, "csv export failed");
  });

  it("logs a failure mid-download, then stops the file", async () => {
    mocks.roles = ["ADMIN"];
    const err = new Error("connection lost");
    async function* rows() {
      yield ["a"];
      throw err;
    }
    const response = await serve(async () => ({ filename: "x.csv", header: ["A"], rows: rows() }));
    expect(response.status).toBe(200);
    await expect(response.arrayBuffer()).rejects.toThrow("connection lost");
    expect(mocks.logError).toHaveBeenCalledWith({ err, path }, "csv export aborted");
  });
});
