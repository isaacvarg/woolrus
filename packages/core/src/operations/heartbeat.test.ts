import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDb, testDb } from "../../test/db";
import { recordWorkerHeartbeat, WORKER_STALE_MS, workerHealth } from "./heartbeat";

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const now = new Date("2026-10-28T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

describe("workerHealth", () => {
  it("is stale when no heartbeat was ever recorded", async () => {
    expect(await workerHealth(db, now)).toBe("stale");
  });

  it("is ok right after a beat", async () => {
    await recordWorkerHeartbeat(db, { version: "1.2.3", now: ago(30_000) });
    expect(await workerHealth(db, now)).toBe("ok");
  });

  it("is stale once the last beat is over 3 minutes old", async () => {
    await recordWorkerHeartbeat(db, { now: ago(WORKER_STALE_MS + 1_000) });
    expect(await workerHealth(db, now)).toBe("stale");
  });

  it("is still ok just under 3 minutes", async () => {
    await recordWorkerHeartbeat(db, { now: ago(WORKER_STALE_MS - 1_000) });
    expect(await workerHealth(db, now)).toBe("ok");
  });
});

describe("recordWorkerHeartbeat", () => {
  it("upserts the single worker row with the version", async () => {
    await recordWorkerHeartbeat(db, { version: "1", now: ago(60_000) });
    await recordWorkerHeartbeat(db, { version: "2", now });
    const rows = await db.serviceHeartbeat.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "worker", version: "2", beatAt: now });
  });

  it("touches the heartbeat file", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "hb-")), "worker-heartbeat");
    await recordWorkerHeartbeat(db, { now, file });
    expect((await stat(file)).isFile()).toBe(true);
  });
});
