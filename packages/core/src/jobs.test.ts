import { describe, expect, it } from "vitest";
import { isFinalAttempt, JOB_RETENTION_SECONDS, queueOptions, queues } from "./jobs";

describe("queueOptions", () => {
  it("keeps finished jobs 30 days on every queue", () => {
    for (const name of Object.values(queues))
      expect(queueOptions[name].deleteAfterSeconds).toBe(JOB_RETENTION_SECONDS);
    expect(JOB_RETENTION_SECONDS).toBe(2_592_000);
  });
});

describe("isFinalAttempt", () => {
  it("is false while retries remain and true on the last run", () => {
    const retryLimit = queueOptions[queues.ratesFetch].retryLimit ?? -1;
    expect(retryLimit).toBe(2);
    expect([0, 1, 2].map((retryCount) => isFinalAttempt({ retryCount, retryLimit }))).toEqual([
      false,
      false,
      true,
    ]);
  });

  it("is true on the only run of a job with no retries", () => {
    expect(isFinalAttempt({ retryCount: 0, retryLimit: 0 })).toBe(true);
  });
});
