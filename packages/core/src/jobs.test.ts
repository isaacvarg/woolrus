import { describe, expect, it } from "vitest";
import { isFinalAttempt, queueOptions, queues } from "./jobs";

describe("isFinalAttempt", () => {
  it("is false while retries remain and true on the last run", () => {
    const { retryLimit } = queueOptions[queues.ratesFetch] ?? { retryLimit: -1 };
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
