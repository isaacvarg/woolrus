import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { forwardErrorEnvelope, TUNNEL_MAX_BYTES } from "./error-tunnel";

let server: Server;
let dsn: string;
const posted: { url?: string; body: string }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      posted.push({ url: req.url, body: Buffer.concat(chunks).toString() });
      res.end("{}");
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  dsn = `http://key@127.0.0.1:${(server.address() as AddressInfo).port}/7`;
});
afterAll(() => server.close());
beforeEach(() => {
  posted.length = 0;
});

const envelope = (envelopeDsn: string, padding = 0) =>
  `${JSON.stringify({ dsn: envelopeDsn })}\n{"type":"event"}\n{"message":"x${"y".repeat(padding)}"}`;
const post = (body: string) => new Request("http://woolrus/api/errors", { method: "POST", body });

describe("error tunnel", () => {
  it("forwards an envelope for the configured DSN", async () => {
    const body = envelope(dsn);
    expect(await forwardErrorEnvelope(post(body), dsn)).toBe(true);
    expect(posted).toEqual([{ url: "/api/7/envelope/", body }]);
  });

  it("drops an envelope for another project or host", async () => {
    const port = new URL(dsn).port;
    for (const other of [
      `http://key@127.0.0.1:${port}/8`,
      `http://key@localhost:${port}/7`,
      "https://key@evil.example/7",
    ]) {
      expect(await forwardErrorEnvelope(post(envelope(other)), dsn)).toBe(false);
    }
    expect(posted).toEqual([]);
  });

  it("drops garbage, oversized bodies, and everything when no DSN is configured", async () => {
    expect(await forwardErrorEnvelope(post("not json"), dsn)).toBe(false);
    expect(await forwardErrorEnvelope(post(envelope(dsn, TUNNEL_MAX_BYTES)), dsn)).toBe(false);
    expect(await forwardErrorEnvelope(post(envelope(dsn)), undefined)).toBe(false);
    expect(posted).toEqual([]);
  });

  it("does not throw when GlitchTip is down", async () => {
    const refused = () => Promise.reject(new Error("ECONNREFUSED"));
    expect(await forwardErrorEnvelope(post(envelope(dsn)), dsn, refused)).toBe(false);
  });
});
