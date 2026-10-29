import { beforeEach, describe, expect, it, vi } from "vitest";

// The health route's rules (SPEC-operations "Health", criterion 6): what degrades, what fails.

const mocks = vi.hoisted(() => ({
  woocommerceHealth: vi.fn(),
  workerHealth: vi.fn(),
  shippingProviderHealth: vi.fn(),
  emailStatus: vi.fn(),
  queryRaw: vi.fn(),
  storageCheck: vi.fn(),
  encryptionKey: vi.fn(),
  fakeShippingProviders: vi.fn(),
}));

vi.mock("@woolrus/core", () => ({
  emailStatus: mocks.emailStatus,
  encryptionKey: mocks.encryptionKey,
  fakeShippingProviders: mocks.fakeShippingProviders,
  shippingProviderHealth: mocks.shippingProviderHealth,
  woocommerceHealth: mocks.woocommerceHealth,
  workerHealth: mocks.workerHealth,
}));
vi.mock("@woolrus/db", () => ({ db: { $queryRaw: mocks.queryRaw } }));
vi.mock("@/server/storage", () => ({ storage: () => ({ check: mocks.storageCheck }) }));

import { GET } from "./route";

beforeEach(() => {
  mocks.encryptionKey.mockReturnValue("key");
  mocks.fakeShippingProviders.mockReturnValue(false);
  mocks.woocommerceHealth.mockResolvedValue("ok");
  mocks.workerHealth.mockResolvedValue("ok");
  mocks.shippingProviderHealth.mockResolvedValue({ degraded: false });
  mocks.emailStatus.mockResolvedValue("ok");
  mocks.queryRaw.mockResolvedValue([{ "?column?": 1 }]);
  mocks.storageCheck.mockResolvedValue("ok");
});

async function health() {
  const response = await GET();
  return { status: response.status, body: await response.json() };
}

describe("GET /api/health", () => {
  it("is ok and not degraded when everything answers", async () => {
    const { status, body } = await health();
    expect(status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      degraded: false,
      checks: { woocommerce: "ok", worker: "ok" },
    });
  });

  it("a failing store degrades health but stays 200", async () => {
    mocks.woocommerceHealth.mockResolvedValue("fail");
    const { status, body } = await health();
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, degraded: true, checks: { woocommerce: "fail" } });
  });

  it("an unconfigured store does not degrade", async () => {
    mocks.woocommerceHealth.mockResolvedValue("unconfigured");
    expect((await health()).body.degraded).toBe(false);
  });

  it("a stale worker degrades health but stays 200", async () => {
    mocks.workerHealth.mockResolvedValue("stale");
    const { status, body } = await health();
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, degraded: true, checks: { worker: "stale" } });
  });

  it("a throwing check degrades instead of failing the endpoint", async () => {
    mocks.woocommerceHealth.mockRejectedValue(new Error("boom"));
    mocks.workerHealth.mockRejectedValue(new Error("boom"));
    const { status, body } = await health();
    expect(status).toBe(200);
    expect(body).toMatchObject({
      degraded: true,
      checks: { woocommerce: "fail", worker: "stale" },
    });
  });

  it("with the database down it is 503 and asks the store and worker nothing", async () => {
    mocks.queryRaw.mockRejectedValue(new Error("down"));
    const { status, body } = await health();
    expect(status).toBe(503);
    expect(body.checks).toMatchObject({ database: "fail", woocommerce: "fail", worker: "stale" });
    expect(mocks.woocommerceHealth).not.toHaveBeenCalled();
    expect(mocks.workerHealth).not.toHaveBeenCalled();
  });

  it("carries only labels: no host, message or provider name", async () => {
    mocks.woocommerceHealth.mockResolvedValue("fail");
    const json = JSON.stringify((await health()).body);
    expect(json).not.toMatch(/http|boom|localhost/i);
  });

  it("a missing encryption key or failing storage is 503", async () => {
    mocks.encryptionKey.mockReturnValue(null);
    expect((await health()).status).toBe(503);
    mocks.encryptionKey.mockReturnValue("key");
    mocks.storageCheck.mockRejectedValue(new Error("down"));
    const { status, body } = await health();
    expect(status).toBe(503);
    expect(body.checks.storage).toBe("fail");
  });

  it("fake shipping providers degrade health in production only", async () => {
    mocks.fakeShippingProviders.mockReturnValue(true);
    expect((await health()).body.degraded).toBe(false);
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect((await health()).body.degraded).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("a throwing shipping check degrades, and a throwing email check reports fail", async () => {
    mocks.shippingProviderHealth.mockRejectedValue(new Error("boom"));
    mocks.emailStatus.mockRejectedValue(new Error("boom"));
    const { status, body } = await health();
    expect(status).toBe(200);
    expect(body).toMatchObject({ degraded: true, checks: { email: "fail" } });
  });

  it("with the database down it doesn't ask for email or shipping status", async () => {
    mocks.queryRaw.mockRejectedValue(new Error("down"));
    const { body } = await health();
    expect(mocks.emailStatus).not.toHaveBeenCalled();
    expect(mocks.shippingProviderHealth).not.toHaveBeenCalled();
    expect(body.checks.email).toBe("fail");
  });
});
