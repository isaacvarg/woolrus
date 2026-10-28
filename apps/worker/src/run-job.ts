import { isFinalAttempt } from "@woolrus/core";
import { createLogger, type Logger } from "@woolrus/logger";
import type { JobWithMetadata } from "pg-boss";

/** Extra fields for the outcome line; `null` means nothing happened worth an `info` line. */
type JobResult = Record<string, unknown> | null | undefined;

/**
 * The one wrapper for every `boss.work` handler (NFR-OPS-01): binds `queue`, `jobId`, `attempt`
 * and `orderId` (when the payload has one) to a child logger, logs the outcome with its duration,
 * and rethrows so pg-boss retries. A failure is `warn` while a retry remains and `error` on the
 * final attempt. Register the queue with `includeMetadata: true`: the attempt comes from it.
 */
export function runJob<T extends object>(
  queue: string,
  handler: (job: JobWithMetadata<T>, log: Logger) => Promise<JobResult>,
  root: Logger = createLogger({ module: "jobs" }),
) {
  return async ([job]: JobWithMetadata<T>[]): Promise<void> => {
    if (!job) return;
    const orderId = (job.data as { orderId?: unknown }).orderId;
    const log = root.child({
      queue,
      jobId: job.id,
      attempt: job.retryCount + 1,
      ...(typeof orderId === "string" ? { orderId } : {}),
    });
    const started = performance.now();
    const durationMs = () => Math.round(performance.now() - started);
    log.debug("job started");
    try {
      const result = await handler(job, log);
      const fields = { durationMs: durationMs(), ...(result ?? {}) };
      if (result === null) log.debug(fields, "job done");
      else log.info(fields, "job done");
    } catch (err) {
      const level = isFinalAttempt(job) ? "error" : "warn";
      log[level]({ err, durationMs: durationMs() }, "job failed");
      throw err;
    }
  };
}
