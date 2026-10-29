import { Writable } from "node:stream";
import { buildLogger } from "@woolrus/logger";
import type { JobWithMetadata } from "pg-boss";
import { describe, expect, it } from "vitest";
import { runJob } from "./run-job";

function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, done) {
      lines.push(JSON.parse(chunk.toString()));
      done();
    },
  });
  return { lines, log: buildLogger(stream) };
}

const INFO = 30;
const WARN = 40;
const ERROR = 50;

function job(data: object, retryCount = 0, retryLimit = 2) {
  return { id: "job-1", data, retryCount, retryLimit } as JobWithMetadata<object>;
}

describe("runJob", () => {
  it("logs the outcome with queue, jobId, attempt, orderId and duration", async () => {
    const { lines, log } = capture();
    await runJob("orders.webhook", async () => ({ changed: 2 }), log)([job({ orderId: "o-1" }, 1)]);
    const outcome = lines.find((l) => l.msg === "job done");
    expect(outcome).toMatchObject({
      level: INFO,
      queue: "orders.webhook",
      jobId: "job-1",
      attempt: 2,
      orderId: "o-1",
      changed: 2,
    });
    expect(typeof outcome?.durationMs).toBe("number");
  });

  it("omits orderId when the payload has none", async () => {
    const { lines, log } = capture();
    await runJob("q", async () => undefined, log)([job({})]);
    expect(lines.find((l) => l.msg === "job done")).not.toHaveProperty("orderId");
  });

  it("warns and rethrows when a failed attempt will retry", async () => {
    const { lines, log } = capture();
    await expect(
      runJob("q", async () => Promise.reject(new Error("boom")), log)([job({}, 0, 2)]),
    ).rejects.toThrow("boom");
    expect(lines.find((l) => l.msg === "job failed")).toMatchObject({ level: WARN, attempt: 1 });
  });

  it("logs error on the final attempt", async () => {
    const { lines, log } = capture();
    await expect(
      runJob("q", async () => Promise.reject(new Error("boom")), log)([job({}, 2, 2)]),
    ).rejects.toThrow("boom");
    expect(lines.find((l) => l.msg === "job failed")).toMatchObject({ level: ERROR, attempt: 3 });
  });

  it("logs a quiet outcome (null result) at debug", async () => {
    const { lines, log } = capture();
    await runJob("q", async () => null, log)([job({})]);
    expect(lines.find((l) => l.msg === "job done")?.level).toBe(20);
  });
});
