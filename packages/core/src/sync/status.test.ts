import type { Db, Role } from "@woolrus/db";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { StoreError } from "../adapters/woocommerce/errors";
import { FakeStoreAdapter } from "../adapters/woocommerce/fake";
import { JOBS_SCHEMA, queues } from "../jobs";
import type { UserActor } from "../permissions";
import { setSecret, updateSettings } from "../settings/service";
import { syncOrders } from "./orders";
import { configuredStore } from "./schedule";
import {
  getSyncStatus,
  listSyncRunErrors,
  listSyncRuns,
  requestSync,
  testStoreConnection,
} from "./status";

// Sync API reads and commands (SPEC-store-sync "API", SC 10).

const db: Db = testDb();
afterAll(() => db.$disconnect());

let admin: UserActor;
beforeEach(async () => {
  await resetDb(db);
  admin = await createActor(db, ["ADMIN"]);
});
afterEach(() => vi.unstubAllEnvs());

const floorRoles: Role[][] = [["PICKER"], ["PACKER"], ["QA"], ["SHIPPER"]];
const minutes = (n: number) => n * 60_000;
const NOW = new Date("2026-10-19T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

function run(data: {
  type?: "ORDERS_POLL" | "ORDERS_WEBHOOK" | "PRODUCTS";
  status: "RUNNING" | "SUCCEEDED" | "PARTIAL" | "FAILED";
  startedAt: Date;
  error?: string;
}) {
  return db.syncRun.create({
    data: {
      type: data.type ?? "ORDERS_POLL",
      status: data.status,
      startedAt: data.startedAt,
      finishedAt: data.status === "RUNNING" ? null : new Date(data.startedAt.getTime() + 1000),
      error: data.error ?? null,
    },
  });
}

/** Manual jobs on a queue (pg-boss's tables aren't reset between tests). */
async function manualJobs(queue: string): Promise<number> {
  const [row] = await db.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT count(*) AS count FROM ${JOBS_SCHEMA}.job WHERE name = $1 AND data->>'reason' = 'manual'`,
    queue,
  );
  return Number(row?.count ?? 0);
}

describe("getSyncStatus", () => {
  it("works for every role", async () => {
    for (const roles of [["ADMIN"], ...floorRoles] as Role[][]) {
      const actor = await createActor(db, roles);
      await expect(getSyncStatus(db, actor, { now: NOW })).resolves.toMatchObject({
        intervalMinutes: 5,
      });
    }
  });

  it("is late before any poll has succeeded", async () => {
    expect(await getSyncStatus(db, admin, { now: NOW })).toEqual({
      lastPoll: null,
      lastSuccessAt: null,
      lastWebhookAt: null,
      intervalMinutes: 5,
      stale: "late",
    });
  });

  it("is fresh after a recent success, PARTIAL included", async () => {
    await run({ status: "PARTIAL", startedAt: ago(minutes(4)) });
    const status = await getSyncStatus(db, admin, { now: NOW });
    expect(status.stale).toBeNull();
    expect(status.lastSuccessAt).toEqual(ago(minutes(4)));
    expect(status.lastPoll).toMatchObject({ status: "PARTIAL", startedAt: ago(minutes(4)) });
  });

  it("is failing when the last finished poll failed, even with a recent success", async () => {
    await run({ status: "SUCCEEDED", startedAt: ago(minutes(6)) });
    await run({ status: "FAILED", startedAt: ago(minutes(1)), error: "errors.sync.unauthorized" });
    expect((await getSyncStatus(db, admin, { now: NOW })).stale).toBe("failing");
  });

  it("looks past a poll still running to the last finished one", async () => {
    await run({ status: "SUCCEEDED", startedAt: ago(minutes(2)) });
    await run({ status: "RUNNING", startedAt: ago(minutes(1)) });
    const status = await getSyncStatus(db, admin, { now: NOW });
    expect(status.stale).toBeNull();
    expect(status.lastPoll).toMatchObject({ status: "RUNNING", finishedAt: null });
  });

  it("is late after 3 × the interval without a success", async () => {
    await updateSettings(db, admin, { syncIntervalMinutes: 10 });
    await run({ status: "SUCCEEDED", startedAt: ago(minutes(29)) });
    expect((await getSyncStatus(db, admin, { now: NOW })).stale).toBeNull();
    expect(
      (await getSyncStatus(db, admin, { now: new Date(NOW.getTime() + minutes(2)) })).stale,
    ).toBe("late");
  });

  it("ignores webhook and product runs for staleness, and reports the last webhook", async () => {
    await run({ status: "SUCCEEDED", startedAt: ago(minutes(1)) });
    await run({ type: "PRODUCTS", status: "FAILED", startedAt: ago(1000) });
    await run({ type: "ORDERS_WEBHOOK", status: "FAILED", startedAt: ago(1000) });
    await db.inboundWebhook.create({
      data: {
        source: "woocommerce",
        deliveryId: "d1",
        topic: "order.created",
        payload: {},
        receivedAt: ago(5000),
      },
    });
    const status = await getSyncStatus(db, admin, { now: NOW });
    expect(status.stale).toBeNull();
    expect(status.lastWebhookAt).toEqual(ago(5000));
  });
});

describe("listSyncRuns", () => {
  it("pages runs newest first and splits the error into key and detail", async () => {
    for (let i = 0; i < 5; i++) await run({ status: "SUCCEEDED", startedAt: ago(minutes(10 - i)) });
    await run({
      status: "FAILED",
      startedAt: ago(0),
      error: "errors.sync.unreachable: GET /orders timed out",
    });

    const first = await listSyncRuns(db, admin, { limit: 4 });
    expect(first.rows).toHaveLength(4);
    expect(first.rows[0]).toMatchObject({
      status: "FAILED",
      errorKey: "errors.sync.unreachable",
      errorDetail: "GET /orders timed out",
    });
    expect(first.nextCursor).not.toBeNull();

    const second = await listSyncRuns(db, admin, { limit: 4, cursor: first.nextCursor ?? "" });
    expect(second.rows).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    const times = [...first.rows, ...second.rows].map((r) => r.startedAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("filters by type and refuses a forged cursor", async () => {
    await run({ status: "SUCCEEDED", startedAt: ago(2000) });
    await run({ type: "PRODUCTS", status: "SUCCEEDED", startedAt: ago(1000) });
    const page = await listSyncRuns(db, admin, { type: "PRODUCTS" });
    expect(page.rows.map((r) => r.type)).toEqual(["PRODUCTS"]);
    await expect(listSyncRuns(db, admin, { cursor: "nope" })).rejects.toMatchObject({
      kind: "BAD_REQUEST",
    });
  });

  it.each(floorRoles)("is forbidden for %s", async (role) => {
    const actor = await createActor(db, [role]);
    await expect(listSyncRuns(db, actor, {})).rejects.toMatchObject({ kind: "FORBIDDEN" });
  });
});

describe("listSyncRunErrors", () => {
  it("links a failed WooCommerce order id to the order it already is", async () => {
    const store = new FakeStoreAdapter();
    const known = store.addOrder();
    await syncOrders(db, store, { type: "ORDERS_POLL", now: store.now() });
    const order = await db.order.findUniqueOrThrow({ where: { wooOrderId: known.id } });

    const failed = await run({ status: "PARTIAL", startedAt: ago(0) });
    await db.syncRunError.createMany({
      data: [
        {
          syncRunId: failed.id,
          externalId: String(known.id),
          error: "errors.sync.importFailed: P2002",
        },
        { syncRunId: failed.id, externalId: "999999", error: "errors.sync.badResponse" },
      ],
    });

    const errors = await listSyncRunErrors(db, admin, { id: failed.id });
    expect(errors).toMatchObject([
      {
        externalId: String(known.id),
        messageKey: "errors.sync.importFailed",
        detail: "P2002",
        order: { id: order.id, number: order.number },
      },
      { externalId: "999999", messageKey: "errors.sync.badResponse", detail: null, order: null },
    ]);
  });

  it("never links product ids to orders", async () => {
    const store = new FakeStoreAdapter();
    const known = store.addOrder();
    await syncOrders(db, store, { type: "ORDERS_POLL", now: store.now() });
    const products = await run({ type: "PRODUCTS", status: "PARTIAL", startedAt: ago(0) });
    await db.syncRunError.create({
      data: {
        syncRunId: products.id,
        externalId: String(known.id),
        error: "errors.sync.badResponse",
      },
    });
    const [error] = await listSyncRunErrors(db, admin, { id: products.id });
    expect(error?.order).toBeNull();
  });

  it("is not found for an unknown run and forbidden for floor roles", async () => {
    await expect(
      listSyncRunErrors(db, admin, { id: "00000000-0000-7000-8000-000000000000" }),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });
    const existing = await run({ status: "SUCCEEDED", startedAt: ago(0) });
    for (const roles of floorRoles) {
      const actor = await createActor(db, roles);
      await expect(listSyncRunErrors(db, actor, { id: existing.id })).rejects.toMatchObject({
        kind: "FORBIDDEN",
      });
    }
  });
});

describe("requestSync", () => {
  it.each([
    ["orders", queues.ordersSync],
    ["products", queues.productsSync],
  ] as const)("queues one manual %s job per idempotency key, audited", async (target, queue) => {
    const before = await manualJobs(queue);
    const key = crypto.randomUUID();
    expect(await requestSync(db, admin, { idempotencyKey: key, target })).toEqual({
      target,
      queued: true,
    });
    expect(await requestSync(db, admin, { idempotencyKey: key, target })).toEqual({
      target,
      queued: true,
    });
    expect(await manualJobs(queue)).toBe(before + 1);
    expect(await db.auditEvent.count({ where: { action: "sync.request", entityId: target } })).toBe(
      1,
    );
  });

  it.each(floorRoles)("is forbidden for %s and queues nothing", async (role) => {
    const actor = await createActor(db, [role]);
    const before = await manualJobs(queues.ordersSync);
    await expect(
      requestSync(db, actor, { idempotencyKey: crypto.randomUUID(), target: "orders" }),
    ).rejects.toMatchObject({ kind: "FORBIDDEN" });
    expect(await manualJobs(queues.ordersSync)).toBe(before);
  });
});

describe("testStoreConnection", () => {
  it("reports the store's units when the store answers", async () => {
    const store = new FakeStoreAdapter();
    store.units = { weight: "kg", dimension: "cm" };
    expect(await testStoreConnection(db, admin, async () => store)).toEqual({
      ok: true,
      units: { weight: "kg", dimension: "cm" },
    });
  });

  it("turns a store failure into its message key", async () => {
    const store = new FakeStoreAdapter();
    store.failNext("ping", new StoreError("unauthorized", "GET / 401", 401));
    expect(await testStoreConnection(db, admin, async () => store)).toEqual({
      ok: false,
      messageKey: "errors.sync.unauthorized",
    });
  });

  it("says not configured when there is no store", async () => {
    expect(await testStoreConnection(db, admin, async () => null)).toEqual({
      ok: false,
      messageKey: "errors.sync.notConfigured",
    });
  });

  it.each(floorRoles)("is forbidden for %s, before touching the store", async (role) => {
    const actor = await createActor(db, [role]);
    const connect = vi.fn(async () => new FakeStoreAdapter());
    await expect(testStoreConnection(db, actor, connect)).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
    expect(connect).not.toHaveBeenCalled();
  });
});

describe("secrets", () => {
  it("appear in no response of the sync API", async () => {
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    const secrets = {
      wooConsumerKey: "ck_secret_value_123",
      wooConsumerSecret: "cs_secret_value_456",
      wooWebhookSecret: "wh_secret_value_789",
    } as const;
    for (const [name, value] of Object.entries(secrets)) {
      await setSecret(db, admin, { name: name as keyof typeof secrets, value });
    }
    await updateSettings(db, admin, { wooStoreUrl: "https://shop.example.com" });
    const failed = await run({
      status: "FAILED",
      startedAt: ago(0),
      error: "errors.sync.unauthorized: GET /wp-json/wc/v3 401",
    });
    await db.syncRunError.create({
      data: { syncRunId: failed.id, externalId: "1", error: "errors.sync.badResponse" },
    });

    // The real HTTP adapter, built from the saved config, against a fetch that refuses it.
    const refused = vi.fn(async () => new Response("{}", { status: 401 }));
    const responses = [
      await getSyncStatus(db, admin),
      await listSyncRuns(db, admin, {}),
      await listSyncRunErrors(db, admin, { id: failed.id }),
      await requestSync(db, admin, { idempotencyKey: crypto.randomUUID(), target: "orders" }),
      await testStoreConnection(db, admin, (db) => configuredStore(db, { fetch: refused })),
    ];
    expect(refused).toHaveBeenCalled();
    const serialised = JSON.stringify(responses);
    for (const value of Object.values(secrets)) expect(serialised).not.toContain(value);
    expect(serialised).toContain("errors.sync.unauthorized");
  });
});
