import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { call, os } from "@orpc/server";
import { AppError } from "@woolrus/core";
import { buildLogger } from "@woolrus/logger";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureServerError, flushErrors, initErrorReporting } from "./error-reporting";
import { type BaseContext, mapErrors } from "./orpc";
import { traced } from "./request-trace";

type Event = {
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  request?: Record<string, unknown>;
  release?: string;
  environment?: string;
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
const context = (): BaseContext => ({
  headers: new Headers({ "x-request-id": "req-1" }),
  log: quiet,
  trace: { userId: "u-1", stationId: "s-1" },
});
const procedure = (fail: () => never) =>
  os
    .$context<BaseContext>()
    .use(mapErrors)
    .handler(async () => fail());

describe("web error reporting", () => {
  it("does nothing without a DSN", () => {
    expect(initErrorReporting({})).toBe(false);
  });

  it("sends unexpected errors with tags, and never an AppError", async () => {
    const { port } = server.address() as AddressInfo;
    initErrorReporting({
      SENTRY_DSN: `http://key@127.0.0.1:${port}/1`,
      WOOLRUS_VERSION: "1.2.3",
      SENTRY_ENVIRONMENT: "staging",
    });

    // An unhandled oRPC error, with PII in the error's own context.
    const bug = Object.assign(new Error("db exploded"), {
      customerName: "Ann Customer",
    });
    await expect(
      call(
        procedure(() => {
          throw bug;
        }),
        undefined,
        { context: context() },
      ),
    ).rejects.toThrow();
    // An expected, translated error.
    await expect(
      call(
        procedure(() => {
          throw new AppError("NOT_FOUND", "errors.notFound");
        }),
        undefined,
        { context: context() },
      ),
    ).rejects.toThrow();
    // A route handler that throws.
    const response = await traced(
      new Request("http://x/rpc/orders/list", {
        method: "POST",
        headers: { authorization: "Bearer secret", cookie: "session=s" },
        body: JSON.stringify({ customerEmail: "ann@example.com" }),
      }),
      "/rpc",
      async (ctx) => {
        ctx.trace.userId = "u-2";
        throw new Error("handler exploded");
      },
      quiet,
    );
    expect(response.status).toBe(500);
    // PII in an error's context is redacted before it leaves.
    captureServerError(
      new Error("with context"),
      { orderId: "o-1" },
      {
        order: {
          customerName: "Ann",
          customerEmail: "ann@example.com",
          shipTo: { address_1: "1 Main" },
        },
      },
    );
    await flushErrors();

    expect(received).toHaveLength(3);
    const redacted = received.find((e) => e.tags?.orderId === "o-1");
    expect(redacted?.extra).toEqual({
      order: { customerName: "[redacted]", customerEmail: "[redacted]", shipTo: "[redacted]" },
    });
    const byUser = (id: string) => received.find((e) => e.tags?.userId === id);
    expect(byUser("u-1")).toMatchObject({
      release: "1.2.3",
      environment: "staging",
      tags: { service: "web", requestId: "req-1", userId: "u-1", stationId: "s-1" },
    });
    expect(byUser("u-2")?.tags).toMatchObject({ service: "web", userId: "u-2" });
    // No body, cookie or authorization header, whatever the SDK attached.
    for (const event of received) {
      expect(event.request?.data).toBeUndefined();
      expect(event.request?.cookies).toBeUndefined();
      const headers = Object.keys((event.request?.headers ?? {}) as object).map((h) =>
        h.toLowerCase(),
      );
      expect(headers).not.toContain("authorization");
      expect(headers).not.toContain("cookie");
    }
  });
});
