import { describe, expect, it } from "vitest";
import { scrubEvent } from "./scrub";

describe("scrubEvent", () => {
  it("redacts PII keys at any depth in extra and contexts", () => {
    const event = scrubEvent({
      extra: {
        order: { customerName: "Ann", lines: [{ shipTo: { address_1: "1 Main" } }], id: "o1" },
      },
      contexts: { job: { email: "a@b.c", queue: "email.send" } },
    });
    expect(event.extra).toEqual({
      order: { customerName: "[redacted]", lines: [{ shipTo: "[redacted]" }], id: "o1" },
    });
    expect(event.contexts).toEqual({ job: { email: "[redacted]", queue: "email.send" } });
  });

  it("drops the body, cookies and authorization header", () => {
    const event = scrubEvent({
      request: {
        url: "/rpc/x",
        data: { customerEmail: "a@b.c" },
        cookies: { session: "s" },
        headers: { Authorization: "Bearer t", cookie: "s=1", "x-request-id": "r1" },
      },
    });
    expect(event.request).toEqual({ url: "/rpc/x", headers: { "x-request-id": "r1" } });
  });
});
