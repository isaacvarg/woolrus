import { z } from "zod";
import { base, Id } from "./base";

// The operations API (SPEC-operations "Failed jobs"). Job rows carry a payload summary only:
// never the payload itself, which can hold a recipient's address.

export const FAILED_JOBS_PAGE = 50;

/** What a failed job was about: the order, why, or an email's template. Never anything personal. */
export const FailedJobSummary = z.object({
  orderId: Id.nullable(),
  reason: z.string().nullable(),
  template: z.string().nullable(),
});
export type FailedJobSummary = z.infer<typeof FailedJobSummary>;

export const FailedJobRow = z.object({
  id: Id,
  queue: z.string(),
  createdAt: z.date(),
  failedAt: z.date().nullable(),
  retryCount: z.number(),
  error: z.string().nullable(),
  summary: FailedJobSummary,
});
export type FailedJobRow = z.infer<typeof FailedJobRow>;

export const ListFailedJobsInput = z.object({
  queue: z.string().max(100).optional(),
  /** `nextCursor` of the previous page. Opaque. */
  cursor: z.string().max(500).optional(),
});
export type ListFailedJobsInput = z.infer<typeof ListFailedJobsInput>;

export const FailedJobPage = z.object({
  rows: z.array(FailedJobRow),
  nextCursor: z.string().nullable(),
  /** All failed jobs, whatever the filter: the nav badge. */
  total: z.number(),
});
export type FailedJobPage = z.infer<typeof FailedJobPage>;

export const FailedJobRef = z.object({ queue: z.string().max(100), id: Id });
export type FailedJobRef = z.infer<typeof FailedJobRef>;

export const operations = {
  jobs: {
    failed: {
      list: base
        .route({
          method: "GET",
          path: "/ops/jobs/failed",
          tags: ["Operations"],
          summary: "Background jobs that used up their retries",
        })
        .input(ListFailedJobsInput)
        .output(FailedJobPage),

      retry: base
        .route({
          method: "POST",
          path: "/ops/jobs/failed/retry",
          tags: ["Operations"],
          summary: "Run a failed job again",
        })
        .input(FailedJobRef)
        .output(z.object({ ok: z.literal(true) })),

      dismiss: base
        .route({
          method: "POST",
          path: "/ops/jobs/failed/dismiss",
          tags: ["Operations"],
          summary: "Remove a failed job",
        })
        .input(FailedJobRef)
        .output(z.object({ ok: z.literal(true) })),
    },
  },
};
