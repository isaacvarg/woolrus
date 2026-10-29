import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  forwardErrorEnvelope,
  resetTunnelLimit,
  TUNNEL_MAX_BYTES,
  TUNNEL_MAX_PER_MINUTE,
} from "./error-tunnel";

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
  resetTunnelLimit();
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

describe("item types and counting", () => {
  it("drops an envelope carrying an attachment or a replay", async () => {
    for (const type of ["attachment", "replay_event", "replay_recording"]) {
      const body = `${JSON.stringify({ dsn })}\n{"type":"event"}\n{}\n{"type":"${type}","length":2}\nab`;
      expect(await forwardErrorEnvelope(post(body), dsn)).toBe(false);
    }
    expect(posted).toEqual([]);
  });

  it("forwards an event followed by a client report", async () => {
    const body = `${JSON.stringify({ dsn })}\n{"type":"event"}\n{"message":"x"}\n{"type":"client_report"}\n{}`;
    expect(await forwardErrorEnvelope(post(body), dsn)).toBe(true);
  });

  it("does not count junk or foreign-DSN envelopes against the limit", async () => {
    for (let i = 0; i < TUNNEL_MAX_PER_MINUTE + 5; i++) {
      await forwardErrorEnvelope(post("not json"), dsn);
      await forwardErrorEnvelope(post(envelope("https://key@evil.example/7")), dsn);
    }
    expect(await forwardErrorEnvelope(post(envelope(dsn)), dsn)).toBe(true);
  });
});

describe("hostile item headers", () => {
  const withItem = (header: string, payload = "{}") =>
    `${JSON.stringify({ dsn })}\n${header}\n${payload}`;

  it("refuses a negative, fractional or string length without hanging", async () => {
    const line = '{"type":"event","length":-31}';
    for (const header of [
      line,
      '{"type":"event","length":-1}',
      '{"type":"event","length":1.5}',
      '{"type":"event","length":"5"}',
      '{"type":"event","length":1e999}',
    ]) {
      const started = performance.now();
      expect(await forwardErrorEnvelope(post(withItem(header)), dsn)).toBe(false);
      expect(performance.now() - started).toBeLessThan(500);
    }
    expect(posted).toEqual([]);
  });

  it("refuses an envelope with more than 20 items", async () => {
    const items = Array.from({ length: 21 }, () => '{"type":"event"}\n{}').join("\n");
    expect(await forwardErrorEnvelope(post(`${JSON.stringify({ dsn })}\n${items}`), dsn)).toBe(
      false,
    );
  });

  it("honours a declared length: a fake attachment line inside the payload is just payload", async () => {
    const payload = 'line one\n{"type":"attachment"}';
    const body = withItem(`{"type":"event","length":${payload.length}}`, payload);
    expect(await forwardErrorEnvelope(post(body), dsn)).toBe(true);
  });

  it("drops an attachment that follows a length-framed item", async () => {
    const body = `${JSON.stringify({ dsn })}\n{"type":"event","length":3}\nabc\n{"type":"attachment","length":2}\nab`;
    expect(await forwardErrorEnvelope(post(body), dsn)).toBe(false);
  });

  it("does not count rejected attachment envelopes against the limit", async () => {
    const attachment = `${JSON.stringify({ dsn })}\n{"type":"attachment","length":2}\nab`;
    for (let i = 0; i < TUNNEL_MAX_PER_MINUTE + 5; i++)
      await forwardErrorEnvelope(post(attachment), dsn);
    expect(await forwardErrorEnvelope(post(envelope(dsn)), dsn)).toBe(true);
  });
});

describe("rate limit", () => {
  it("stops forwarding past the per-minute cap", async () => {
    for (let i = 0; i < TUNNEL_MAX_PER_MINUTE; i++)
      expect(await forwardErrorEnvelope(post(envelope(dsn)), dsn)).toBe(true);
    expect(await forwardErrorEnvelope(post(envelope(dsn)), dsn)).toBe(false);
    expect(posted).toHaveLength(TUNNEL_MAX_PER_MINUTE);
  });
});
