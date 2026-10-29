import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { buildLogger } from "@woolrus/logger";
import type { JobWithMetadata } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { flushErrors, initErrorReporting } from "./error-reporting";
import { runJob } from "./run-job";

type Event = {
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  request?: Record<string, unknown>;
  release?: string;
  environment?: string;
  exception?: { values?: { value?: string }[] };
};

/** A local stand-in for GlitchTip's ingest: collects the error events of every envelope posted. */
let server: Server;
const received: Event[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const lines = Buffer.concat(chunks).toString().split("\n");
      for (let i = 0; i < lines.length - 1; i++) {
        const header = JSON.parse(lines[i] ?? "{}") as { type?: string };
        if (header.type === "event") received.push(JSON.parse(lines[i + 1] ?? "{}") as Event);
      }
      res.end("{}");
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
});
afterAll(() => server.close());

const quiet = buildLogger();
const job = (retryCount: number): JobWithMetadata<object> =>
  ({ id: "job-1", data: { orderId: "o-1" }, retryCount, retryLimit: 2 }) as JobWithMetadata<object>;

describe("worker error reporting", () => {
  it("does nothing without a DSN", () => {
    expect(initErrorReporting({})).toBe(false);
  });

  it("sends a final-attempt error with tags and scrubbed context, not a retryable one", async () => {
    const { port } = server.address() as AddressInfo;
    expect(
      initErrorReporting({
        SENTRY_DSN: `http://key@127.0.0.1:${port}/1`,
        WOOLRUS_VERSION: "1.2.3",
        SENTRY_ENVIRONMENT: "staging",
      }),
    ).toBe(true);
    const boom = new Error("boom");
    const run = runJob(
      "orders.webhook",
      async () => {
        throw boom;
      },
      quiet,
    );

    await expect(run([job(0)])).rejects.toThrow("boom"); // attempt 1 of 3: will retry
    await expect(run([job(2)])).rejects.toThrow("boom"); // final
    await flushErrors();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      release: "1.2.3",
      environment: "staging",
      tags: { service: "worker", queue: "orders.webhook", jobId: "job-1", orderId: "o-1" },
    });
  });
});
