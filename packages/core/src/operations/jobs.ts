import type {
  FailedJobPage,
  FailedJobRef,
  FailedJobSummary,
  ListFailedJobsInput,
} from "@woolrus/contracts";
import { FAILED_JOBS_PAGE } from "@woolrus/contracts";
import type { Db } from "@woolrus/db";
import { recordAudit } from "../audit";
import { bossOn } from "../enqueue";
import { AppError, notFound } from "../errors";
import { JOBS_SCHEMA } from "../jobs";
import { type Actor, assertCan } from "../permissions";

// The failed-jobs page (SPEC-operations "Failed jobs", NFR-REL-03). pg-boss keeps a job in state
// `failed` once its retries are exhausted. Its tables aren't Prisma's, so reads are raw SQL.

type JobRow = {
  id: string;
  name: string;
  created_on: Date;
  completed_on: Date | null;
  retry_count: number;
  output: unknown;
  data: unknown;
};

/** Where the previous page stopped: failed-at desc, id desc. */
type Cursor = { at: string; id: string };

const encodeCursor = (row: JobRow): string =>
  Buffer.from(
    JSON.stringify([(row.completed_on ?? row.created_on).toISOString(), row.id]),
  ).toString("base64url");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function decodeCursor(cursor: string): Cursor {
  try {
    const [at, id] = JSON.parse(Buffer.from(cursor, "base64url").toString());
    // Both are cast in SQL, so only the exact forms the server emits get through: anything else
    // would be a database error, not a 400.
    if (typeof at === "string" && typeof id === "string" && UUID.test(id)) {
      const date = new Date(at);
      if (!Number.isNaN(date.getTime()) && date.toISOString() === at) return { at, id };
    }
  } catch {}
  throw new AppError("BAD_REQUEST", "errors.validation", { cursor: "errors.field.invalid" });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/**
 * What a job was about, picked field by field: the payload of `email.send` holds the recipient's
 * address and its params, so nothing is ever copied across wholesale.
 */
export function summarizePayload(data: unknown): FailedJobSummary {
  const payload = isRecord(data) ? data : {};
  return {
    orderId: text(payload.orderId),
    reason: text(payload.reason),
    template: text(payload.template),
  };
}

const EMAIL = /[^\s@<>"']+@[\w-]+(?:\.[\w-]+)+/g;

/** The error message a failed handler stored, never its stack, with email addresses masked. */
function errorMessage(output: unknown): string | null {
  const message = isRecord(output) ? text(output.message) : text(output);
  return message === null ? null : message.replace(EMAIL, "[redacted]");
}

export async function listFailedJobs(
  db: Db,
  actor: Actor,
  { queue, cursor }: Partial<ListFailedJobsInput>,
): Promise<FailedJobPage> {
  assertCan(actor, "ops.jobs");
  const after = cursor ? decodeCursor(cursor) : null;
  const params: unknown[] = [];
  const where = ["state = 'failed'"];
  if (queue) {
    params.push(queue);
    where.push(`name = $${params.length}`);
  }
  if (after) {
    params.push(after.at, after.id);
    where.push(
      `(coalesce(completed_on, created_on), id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
    );
  }
  const [rows, [totals]] = await Promise.all([
    db.$queryRawUnsafe<JobRow[]>(
      `SELECT id, name, created_on, completed_on, retry_count, output, data
         FROM ${JOBS_SCHEMA}.job
        WHERE ${where.join(" AND ")}
        ORDER BY coalesce(completed_on, created_on) DESC, id DESC
        LIMIT ${FAILED_JOBS_PAGE + 1}`,
      ...params,
    ),
    db.$queryRawUnsafe<{ total: bigint }[]>(
      `SELECT count(*) AS total FROM ${JOBS_SCHEMA}.job WHERE state = 'failed'`,
    ),
  ]);
  const page = rows.slice(0, FAILED_JOBS_PAGE);
  const last = page.at(-1);
  return {
    rows: page.map((row) => ({
      id: row.id,
      queue: row.name,
      createdAt: row.created_on,
      failedAt: row.completed_on,
      retryCount: row.retry_count,
      error: errorMessage(row.output),
      summary: summarizePayload(row.data),
    })),
    nextCursor: rows.length > FAILED_JOBS_PAGE && last ? encodeCursor(last) : null,
    total: Number(totals?.total ?? 0),
  };
}

/** Handlers are idempotent (labels by idempotency key, emails by `Idempotency-Key`), so a retry is safe. */
export function retryFailedJob(db: Db, actor: Actor, { queue, id }: FailedJobRef) {
  return command(db, actor, { queue, id }, "job.retry", (boss, options) =>
    boss.retry(queue, id, options),
  );
}

export function dismissFailedJob(db: Db, actor: Actor, { queue, id }: FailedJobRef) {
  return command(db, actor, { queue, id }, "job.dismiss", (boss, options) =>
    boss.deleteJob(queue, id, options),
  );
}

async function command(
  db: Db,
  actor: Actor,
  { queue, id }: FailedJobRef,
  action: "job.retry" | "job.dismiss",
  run: (
    boss: ReturnType<typeof bossOn>["boss"],
    options: { db: ReturnType<typeof bossOn>["db"] },
  ) => Promise<unknown>,
): Promise<{ ok: true }> {
  assertCan(actor, "ops.jobs");
  await db.$transaction(async (tx) => {
    // Only a failed job: a stale page must not retry or delete one that has since moved on.
    const [job] = await tx.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM ${JOBS_SCHEMA}.job WHERE name = $1 AND id = $2::uuid AND state = 'failed' FOR UPDATE`,
      queue,
      id,
    );
    if (!job) throw notFound();
    const { boss, db: bossDb } = bossOn(tx);
    await run(boss, { db: bossDb });
    await recordAudit(tx, actor, { entityType: "Job", entityId: id, action, after: { queue } });
  });
  return { ok: true };
}
