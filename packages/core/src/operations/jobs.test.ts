import type { Db, Role } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { JOBS_SCHEMA, queues } from "../jobs";
import type { UserActor } from "../permissions";
import { dismissFailedJob, listFailedJobs, retryFailedJob } from "./jobs";

// The failed-jobs page's reads and commands (SPEC-operations "Failed jobs", SC 8).

const db: Db = testDb();
afterAll(() => db.$disconnect());

let admin: UserActor;
beforeEach(async () => {
  await resetDb(db);
  await db.$executeRawUnsafe(`DELETE FROM ${JOBS_SCHEMA}.job`);
  admin = await createActor(db, ["ADMIN"]);
});

async function failedJob(
  queue: string,
  data: object,
  { failedAt = new Date(), message = "boom" }: { failedAt?: Date; message?: string } = {},
): Promise<string> {
  const [row] = await db.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO ${JOBS_SCHEMA}.job (name, data, state, retry_limit, retry_count, output, completed_on)
     VALUES ($1, $2::jsonb, 'failed', 2, 2, $3::jsonb, $4) RETURNING id`,
    queue,
    JSON.stringify(data),
    JSON.stringify({ message, stack: "Error: secret stack\n at x" }),
    failedAt,
  );
  if (!row) throw new Error("insert failed");
  return row.id;
}

const jobState = async (id: string) =>
  (
    await db.$queryRawUnsafe<{ state: string }[]>(
      `SELECT state FROM ${JOBS_SCHEMA}.job WHERE id = $1::uuid`,
      id,
    )
  )[0]?.state ?? null;

describe("listFailedJobs", () => {
  it("lists failed jobs newest first with queue, error, attempts and an order link", async () => {
    const old = await failedJob(
      queues.ratesFetch,
      { orderId: "o-1", generation: 1 },
      {
        failedAt: new Date("2026-10-01T00:00:00Z"),
        message: "carrier down",
      },
    );
    const recent = await failedJob(
      queues.ordersSync,
      { reason: "manual" },
      {
        failedAt: new Date("2026-10-02T00:00:00Z"),
      },
    );
    await db.$executeRawUnsafe(
      `INSERT INTO ${JOBS_SCHEMA}.job (name, data, state) VALUES ('orders.sync', '{}', 'completed')`,
    );

    const page = await listFailedJobs(db, admin, {});
    expect(page.rows.map((r) => r.id)).toEqual([recent, old]);
    expect(page.rows[1]).toMatchObject({
      queue: queues.ratesFetch,
      retryCount: 2,
      error: "carrier down",
      summary: { orderId: "o-1", reason: null, template: null },
    });
    expect(page.rows[0]?.summary.reason).toBe("manual");
    expect(page.nextCursor).toBeNull();
  });

  it("never returns an email's recipient, params or the stack", async () => {
    await failedJob(queues.emailSend, {
      to: "customer@example.com",
      template: "invitation",
      params: { url: "https://x/secret" },
      locale: "en",
      idempotencyKey: "k",
    });
    const page = await listFailedJobs(db, admin, {});
    expect(page.rows[0]?.summary).toEqual({ orderId: null, reason: null, template: "invitation" });
    const json = JSON.stringify(page);
    expect(json).not.toContain("customer@example.com");
    expect(json).not.toContain("secret");
  });

  it("filters by queue and pages 50 at a time", async () => {
    for (let i = 0; i < 51; i++)
      await failedJob(queues.storageDelete, { keys: [] }, { failedAt: new Date(2026, 9, 1, 0, i) });
    await failedJob(queues.ordersSync, { reason: "schedule" });

    const first = await listFailedJobs(db, admin, { queue: queues.storageDelete });
    expect(first.rows).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
    const second = await listFailedJobs(db, admin, {
      queue: queues.storageDelete,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.rows).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
  });
});

describe("listFailedJobs input", () => {
  it("refuses a cursor whose id isn't a uuid", async () => {
    const cursor = Buffer.from(JSON.stringify(["2026-01-01T00:00:00Z", "x"])).toString("base64url");
    await expect(listFailedJobs(db, admin, { cursor })).rejects.toMatchObject({
      kind: "BAD_REQUEST",
    });
  });

  it("refuses a cursor whose timestamp Postgres would reject", async () => {
    const id = crypto.randomUUID();
    for (const at of ["1", "foo 1", "2026-01-01"]) {
      const cursor = Buffer.from(JSON.stringify([at, id])).toString("base64url");
      await expect(listFailedJobs(db, admin, { cursor })).rejects.toMatchObject({
        kind: "BAD_REQUEST",
      });
    }
  });

  it("masks email addresses in a stored error message", async () => {
    await failedJob(
      queues.ordersSync,
      { reason: "manual" },
      { message: "550 rejected ann@example.com: no" },
    );
    const page = await listFailedJobs(db, admin, {});
    expect(page.rows[0]?.error).toBe("550 rejected [redacted]: no");
  });
});

describe("retryFailedJob", () => {
  it("puts the job back to retry and writes an audit row", async () => {
    const id = await failedJob(queues.ordersSync, { reason: "manual" });
    await retryFailedJob(db, admin, { queue: queues.ordersSync, id });
    expect(await jobState(id)).toBe("retry");
    const audit = await db.auditEvent.findFirstOrThrow({ where: { entityType: "Job" } });
    expect(audit).toMatchObject({ entityId: id, action: "job.retry", actorId: admin.userId });
  });

  it("refuses a job that isn't failed", async () => {
    await expect(
      retryFailedJob(db, admin, { queue: queues.ordersSync, id: crypto.randomUUID() }),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });
  });
});

describe("dismissFailedJob", () => {
  it("deletes the job and writes an audit row", async () => {
    const id = await failedJob(queues.ordersSync, { reason: "manual" });
    await dismissFailedJob(db, admin, { queue: queues.ordersSync, id });
    expect(await jobState(id)).toBeNull();
    const audit = await db.auditEvent.findFirstOrThrow({ where: { entityType: "Job" } });
    expect(audit).toMatchObject({ entityId: id, action: "job.dismiss" });
  });
});

describe("commands on a job that is not failed (stale page)", () => {
  async function jobIn(state: string): Promise<string> {
    const id = await failedJob(queues.ordersSync, { reason: "manual" });
    await db.$executeRawUnsafe(
      `UPDATE ${JOBS_SCHEMA}.job SET state = $1::${JOBS_SCHEMA}.job_state WHERE id = $2::uuid`,
      state,
      id,
    );
    return id;
  }

  it.each(["completed", "active", "retry", "created"])(
    "refuses retry and dismiss of a %s job and changes nothing",
    async (state) => {
      const id = await jobIn(state);
      const args = { queue: queues.ordersSync, id };
      await expect(retryFailedJob(db, admin, args)).rejects.toMatchObject({ kind: "NOT_FOUND" });
      await expect(dismissFailedJob(db, admin, args)).rejects.toMatchObject({ kind: "NOT_FOUND" });
      expect(await jobState(id)).toBe(state);
      expect(await db.auditEvent.count({ where: { entityType: "Job" } })).toBe(0);
    },
  );

  it("refuses the right id under the wrong queue name", async () => {
    const id = await failedJob(queues.ordersSync, { reason: "manual" });
    await expect(
      retryFailedJob(db, admin, { queue: queues.storageDelete, id }),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });
    expect(await jobState(id)).toBe("failed");
  });

  it("two retries of one job: one succeeds, one is NOT_FOUND, one audit row", async () => {
    const id = await failedJob(queues.ordersSync, { reason: "manual" });
    const args = { queue: queues.ordersSync, id };
    const results = await Promise.allSettled([
      retryFailedJob(db, admin, args),
      retryFailedJob(db, admin, args),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await db.auditEvent.count({ where: { entityType: "Job" } })).toBe(1);
  });
});

describe("permissions", () => {
  const others: Role[][] = [["PICKER"], ["PACKER"], ["QA"], ["SHIPPER"]];
  it.each(others)("forbids %s on all three procedures", async (...roles) => {
    const actor = await createActor(db, roles);
    const id = await failedJob(queues.ordersSync, { reason: "manual" });
    const args = { queue: queues.ordersSync, id };
    await expect(listFailedJobs(db, actor, {})).rejects.toMatchObject({ kind: "FORBIDDEN" });
    await expect(retryFailedJob(db, actor, args)).rejects.toMatchObject({ kind: "FORBIDDEN" });
    await expect(dismissFailedJob(db, actor, args)).rejects.toMatchObject({ kind: "FORBIDDEN" });
    expect(await jobState(id)).toBe("failed");
  });
});
