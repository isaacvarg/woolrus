import { randomBytes } from "node:crypto";
import type { Db } from "@woolrus/db";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import {
  LumexiaAuthError,
  LumexiaBadResponse,
  LumexiaUnavailable,
} from "../adapters/lumexia/errors";
import { FakeLumexiaClient } from "../adapters/lumexia/fake";
import { AppError } from "../errors";
import type { UserActor } from "../permissions";
import { setSecret, updateSettings } from "../settings/service";
import {
  lumexiaClientFor,
  lumexiaHealth,
  resetLumexiaHealthCache,
  testLumexiaConnection,
} from "./connection";

// SPEC-lumexia "Adapter" and success criterion 2: the client from Settings, health, Test connection.

const db: Db = testDb();
afterAll(() => db.$disconnect());

let admin: UserActor;
beforeEach(async () => {
  await resetDb(db);
  resetLumexiaHealthCache();
  vi.stubEnv("SETTINGS_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
  // Never pick up the developer's .env fallback.
  vi.stubEnv("LUMEXIA_BASE_URL", undefined);
  vi.stubEnv("LUMEXIA_API_KEY", undefined);
  admin = await createActor(db, ["ADMIN"]);
});
afterEach(() => vi.unstubAllEnvs());

describe("lumexiaClientFor", () => {
  it("is null until both the URL and the key are saved", async () => {
    expect(await lumexiaClientFor(db)).toBeNull();
    await updateSettings(db, admin, { lumexiaBaseUrl: "https://lumexia.example.test" });
    expect(await lumexiaClientFor(db)).toBeNull();
    await setSecret(db, admin, { name: "lumexiaApiKey", value: "lmx_saved_key" });
    expect(await lumexiaClientFor(db)).not.toBeNull();
  });

  it("is null with a key but no URL", async () => {
    await setSecret(db, admin, { name: "lumexiaApiKey", value: "lmx_saved_key" });
    expect(await lumexiaClientFor(db)).toBeNull();
  });

  it("calls the saved URL with the saved key", async () => {
    await updateSettings(db, admin, { lumexiaBaseUrl: "https://lumexia.example.test" });
    await setSecret(db, admin, { name: "lumexiaApiKey", value: "lmx_saved_key" });
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({ ok: true, apiVersion: "1", key: { userId: "u", scopes: ["read"] } }),
    );
    const client = await lumexiaClientFor(db, { fetch: fetch as typeof globalThis.fetch });
    await client?.ping();
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://lumexia.example.test/api/v1/health");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer lmx_saved_key");
  });
});

describe("lumexiaHealth", () => {
  const client = (fake: FakeLumexiaClient | null) => vi.fn(async () => fake);

  it("is ok when Lumexia answers", async () => {
    expect(await lumexiaHealth(db, { client: client(new FakeLumexiaClient()) })).toBe("ok");
  });

  it("is unconfigured without a client", async () => {
    expect(await lumexiaHealth(db, { client: client(null) })).toBe("unconfigured");
  });

  it("is down when Lumexia fails, refuses the key, or never answers", async () => {
    const down = new FakeLumexiaClient();
    down.setDown(true);
    expect(await lumexiaHealth(db, { client: client(down) })).toBe("down");

    resetLumexiaHealthCache();
    const refused = new FakeLumexiaClient();
    refused.failNext(401);
    expect(await lumexiaHealth(db, { client: client(refused) })).toBe("down");

    resetLumexiaHealthCache();
    const hanging = { ping: () => new Promise<void>(() => {}) } as unknown as FakeLumexiaClient;
    expect(await lumexiaHealth(db, { client: client(hanging), timeoutMs: 20 })).toBe("down");
  });

  it("is down when the config can't be read", async () => {
    const broken = vi.fn(async () => {
      throw new Error("bad key");
    });
    expect(await lumexiaHealth(db, { client: broken })).toBe("down");
  });

  it("doesn't ping again within 30 s, then does, sharing one in-flight ping", async () => {
    const fake = new FakeLumexiaClient();
    const pings = () => fake.calls.filter((c) => c.method === "ping").length;
    await Promise.all([
      lumexiaHealth(db, { client: client(fake), now: 1_000 }),
      lumexiaHealth(db, { client: client(fake), now: 1_000 }),
    ]);
    await lumexiaHealth(db, { client: client(fake), now: 30_999 });
    expect(pings()).toBe(1);
    await lumexiaHealth(db, { client: client(fake), now: 31_000 });
    expect(pings()).toBe(2);
  });
});

describe("testLumexiaConnection", () => {
  const connect = (fake: FakeLumexiaClient | null) => async () => fake;

  it("is ok when Lumexia answers the saved key", async () => {
    expect(await testLumexiaConnection(db, admin, connect(new FakeLumexiaClient()))).toEqual({
      status: "ok",
    });
  });

  it("is unconfigured without a URL and key", async () => {
    expect(await testLumexiaConnection(db, admin, connect(null))).toEqual({
      status: "unconfigured",
      messageKey: "errors.lumexia.unconfigured",
    });
  });

  it("is down with the reason when Lumexia fails", async () => {
    for (const [error, messageKey] of [
      [new LumexiaUnavailable("GET /api/v1/health: 503", 503), "errors.lumexia.unavailable"],
      [new LumexiaAuthError("GET /api/v1/health: 401", 401), "errors.lumexia.unauthorized"],
      [new LumexiaBadResponse("GET /api/v1/health: 404"), "errors.lumexia.badResponse"],
    ] as const) {
      const fake = new FakeLumexiaClient();
      fake.ping = async () => {
        throw error;
      };
      expect(await testLumexiaConnection(db, admin, connect(fake))).toEqual({
        status: "down",
        messageKey,
      });
    }
  });

  it("uses the saved settings by default", async () => {
    expect(await testLumexiaConnection(db, admin)).toMatchObject({ status: "unconfigured" });
  });

  it("is for admins only (lumexia.manage)", async () => {
    for (const role of ["PICKER", "PACKER", "QA", "SHIPPER", "RATE_LAB"] as const) {
      const actor = await createActor(db, [role]);
      const fake = new FakeLumexiaClient();
      const error = await testLumexiaConnection(db, actor, connect(fake)).catch((e) => e);
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ kind: "FORBIDDEN" });
      expect(fake.calls).toEqual([]);
    }
  });
});
