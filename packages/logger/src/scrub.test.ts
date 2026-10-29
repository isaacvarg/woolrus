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

  it("redacts breadcrumb data and masks emails in breadcrumbs and exception messages", () => {
    const event = scrubEvent({
      breadcrumbs: [
        { message: "sent to ann@example.com", data: { customerName: "Ann", url: "/x" } },
      ],
      exception: { values: [{ value: "bounce for bob@example.org" }] },
    });
    expect(event.breadcrumbs).toEqual([
      { message: "sent to [redacted]", data: { customerName: "[redacted]", url: "/x" } },
    ]);
    expect(event.exception?.values?.[0]?.value).toBe("bounce for [redacted]");
  });

  it("strips search terms from URLs, the query string, breadcrumb URLs and the message", () => {
    const event = scrubEvent({
      message: "failed for ann@example.com",
      transaction: "/orders?search=Jane+Doe",
      request: {
        url: "https://woolrus.test/orders?search=Jane+Doe#top",
        query_string: "search=Jane+Doe",
      },
      breadcrumbs: [
        { data: { url: "/rpc/orders/list?input=%7B%22search%22%3A%22Jane%22%7D", method: "GET" } },
        { data: { from: "/orders?search=Jane", to: "/orders/o-1?search=Jane" } },
      ],
    });
    expect(event.request).toEqual({ url: "https://woolrus.test/orders" });
    expect(event.message).toBe("failed for [redacted]");
    expect(event.transaction).toBe("/orders");
    expect(event.breadcrumbs).toEqual([
      { data: { url: "/rpc/orders/list", method: "GET" } },
      { data: { from: "/orders", to: "/orders/o-1" } },
    ]);
  });
});
