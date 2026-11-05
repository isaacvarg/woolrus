import { RATE_LAB_MAX_COMBINATIONS_CEILING } from "@woolrus/contracts";
import { describe, expect, it } from "vitest";
import { PROVIDER_TIMEOUT_MS } from "./adapters/shipping/provider";
import {
  isFinalAttempt,
  JOB_RETENTION_SECONDS,
  queueOptions,
  queues,
  RATE_LAB_RUN_EXPIRE_SECONDS,
} from "./jobs";
import { LAB_CONCURRENCY } from "./rate-lab/runs";

describe("queueOptions", () => {
  it("keeps finished jobs 30 days on every queue", () => {
    for (const name of Object.values(queues))
      expect(queueOptions[name].deleteAfterSeconds).toBe(JOB_RETENTION_SECONDS);
    expect(JOB_RETENTION_SECONDS).toBe(2_592_000);
  });
});

describe("woo.push", () => {
  it("retries 8 times with backoff", () => {
    expect(queueOptions[queues.wooPush]).toMatchObject({
      retryLimit: 8,
      retryDelay: 60,
      retryBackoff: true,
    });
  });
});

describe("rateLab.run", () => {
  it("never retries: a re-run is a new run", () => {
    expect(queueOptions[queues.rateLabRun].retryLimit).toBe(0);
  });

  it("outlives the longest run the cap allows, within pg-boss's 24-hour limit", () => {
    // Every combination of the largest run waiting out the provider timeout, three at a time.
    const longest =
      (RATE_LAB_MAX_COMBINATIONS_CEILING / LAB_CONCURRENCY) * (PROVIDER_TIMEOUT_MS / 1000);
    expect(queueOptions[queues.rateLabRun].expireInSeconds).toBe(RATE_LAB_RUN_EXPIRE_SECONDS);
    expect(RATE_LAB_RUN_EXPIRE_SECONDS).toBeGreaterThan(longest * 1.05);
    expect(RATE_LAB_RUN_EXPIRE_SECONDS).toBeLessThanOrEqual(24 * 60 * 60);
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
