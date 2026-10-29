import { isFinalAttempt } from "@woolrus/core";
import { createLogger, type Logger } from "@woolrus/logger";
import type { JobWithMetadata } from "pg-boss";
import { captureJobError } from "./error-reporting";

/** Extra fields for the outcome line; `null` means nothing happened worth an `info` line. */
type JobResult = Record<string, unknown> | null | undefined;

/**
 * The one wrapper for every `boss.work` handler (NFR-OPS-01): binds `queue`, `jobId`, `attempt`
 * and `orderId` (when the payload has one) to a child logger, logs the outcome with its duration,
 * and rethrows so pg-boss retries. A failure is `warn` while a retry remains and `error` on the
 * final attempt, which is also sent to GlitchTip. Register the queue with `includeMetadata: true`: the attempt comes from it.
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
      const final = isFinalAttempt(job);
      log[final ? "error" : "warn"]({ err, durationMs: durationMs() }, "job failed");
      // Only the final attempt reaches GlitchTip, so a retry that succeeds makes no noise.
      if (final) {
        captureJobError(err, {
          queue,
          jobId: job.id,
          ...(typeof orderId === "string" ? { orderId } : {}),
        });
      }
      throw err;
    }
  };
}
