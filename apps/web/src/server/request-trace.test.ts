import { Writable } from "node:stream";
import { buildLogger } from "@woolrus/logger";
import { describe, expect, it } from "vitest";
import { requestIdOf, traced } from "./request-trace";

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

const request = (headers: Record<string, string> = {}) =>
  new Request("http://localhost/rpc/orders/list", { method: "POST", headers });

describe("traced", () => {
  it("logs one line with procedure, status, duration, requestId and userId, and sets x-request-id", async () => {
    const { lines, log } = capture();
    const response = await traced(
      request(),
      "/rpc",
      async (context) => {
        context.trace.userId = "u-1";
        return new Response("ok", { status: 200 });
      },
      log,
    );
    const requestId = response.headers.get("x-request-id");
    expect(requestId).toBeTruthy();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 30,
      procedure: "orders/list",
      status: 200,
      requestId,
      userId: "u-1",
    });
    expect(typeof lines[0]?.durationMs).toBe("number");
  });

  it("reuses an incoming x-request-id, for the context headers too", async () => {
    const { log } = capture();
    let seen: string | undefined;
    const response = await traced(
      request({ "x-request-id": "abc" }),
      "/rpc",
      async (context) => {
        seen = requestIdOf(context.headers);
        return new Response(null, { status: 204 });
      },
      log,
    );
    expect(seen).toBe("abc");
    expect(response.headers.get("x-request-id")).toBe("abc");
  });

  it("replaces an incoming x-request-id that is too long or has odd characters", async () => {
    for (const bad of ["x".repeat(129), 'a b"c']) {
      const { log } = capture();
      const response = await traced(
        request({ "x-request-id": bad }),
        "/rpc",
        async () => new Response(null, { status: 204 }),
        log,
      );
      const id = response.headers.get("x-request-id");
      expect(id).not.toBe(bad);
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("logs 4xx at info and 5xx at error", async () => {
    const { lines, log } = capture();
    await traced(request(), "/rpc", async () => new Response(null, { status: 403 }), log);
    await traced(request(), "/rpc", async () => new Response(null, { status: 500 }), log);
    expect(lines.map((l) => [l.status, l.level])).toEqual([
      [403, 30],
      [500, 50],
    ]);
  });

  it("answers 500 with the id when the handler throws", async () => {
    const { lines, log } = capture();
    const response = await traced(
      request(),
      "/rpc",
      async () => Promise.reject(new Error("boom")),
      log,
    );
    expect(response.status).toBe(500);
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(lines[0]).toMatchObject({ level: 50, status: 500 });
    expect(lines[0]).toHaveProperty("err");
  });
});
