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

  it("keeps only allowlisted request headers: no referer, next-url or client addresses", () => {
    const event = scrubEvent({
      request: {
        headers: {
          Referer: "https://woolrus.test/orders?search=Jane",
          "next-url": "/orders?search=Jane",
          "x-forwarded-for": "203.0.113.9",
          "user-agent": "ua",
          "Content-Type": "application/json",
        },
      },
    });
    expect(event.request?.headers).toEqual({
      "user-agent": "ua",
      "Content-Type": "application/json",
    });
  });

  it("strips fragments and userinfo from URLs", () => {
    const event = scrubEvent({
      request: { url: "https://bob:secret@woolrus.test/orders#frag?x=ann@x.com" },
      transaction: "/orders#frag?x=ann@x.com",
      breadcrumbs: [
        { data: { from: "/a#f?q=1", to: "//u:p@h/b?q=1", url: "https://u:p@h/c?q=1" } },
      ],
    });
    expect(event.request?.url).toBe("https://woolrus.test/orders");
    expect(event.transaction).toBe("/orders");
    expect(event.breadcrumbs?.[0]?.data).toEqual({ from: "/a", to: "//h/b", url: "https://h/c" });
  });

  it("strips userinfo whose password contains an @", () => {
    const event = scrubEvent({
      request: { url: "https://bob:p@ss@woolrus.test/orders" },
      breadcrumbs: [{ data: { url: "//u:p@a@h/b" } }],
    });
    expect(event.request?.url).toBe("https://woolrus.test/orders");
    expect(event.breadcrumbs?.[0]?.data).toEqual({ url: "//h/b" });
  });

  it("masks emails and strips URL queries in any string of extra, tags and breadcrumb data", () => {
    const event = scrubEvent({
      extra: { note: "bounced for ann@example.com", link: "/orders?search=Jane" },
      tags: { page: "/orders?search=Jane" },
      breadcrumbs: [{ data: { arguments: ["sent to ann@example.com"] } }],
    });
    expect(event.extra).toEqual({ note: "bounced for [redacted]", link: "/orders" });
    expect(event.tags).toEqual({ page: "/orders" });
    expect(event.breadcrumbs?.[0]?.data).toEqual({ arguments: ["sent to [redacted]"] });
  });

  it("matches PII keys whatever their case or separators, and WooCommerce's spellings", () => {
    const event = scrubEvent({
      extra: {
        Customer_Email: "a@b.c",
        "customer-note": "n",
        Company: "Acme",
        city: "Austin",
        ok: 1,
      },
    });
    expect(event.extra).toEqual({
      Customer_Email: "[redacted]",
      "customer-note": "[redacted]",
      Company: "[redacted]",
      city: "[redacted]",
      ok: 1,
    });
  });

  it("redacts the value of a { key, value } meta pair whose key is PII", () => {
    const event = scrubEvent({
      extra: {
        meta: [
          { key: "billing_phone", value: "555" },
          { key: "gift", value: "ok" },
        ],
      },
    });
    expect(event.extra).toEqual({
      meta: [
        { key: "billing_phone", value: "[redacted]" },
        { key: "gift", value: "ok" },
      ],
    });
  });

  it("masks emails in the transaction, exception values and kept header values", () => {
    const event = scrubEvent({
      transaction: "GET ann@example.com",
      exception: {
        values: [{ value: "/orders?search=Jane failed" }, { value: "x ann@example.com" }],
      },
      request: { headers: { "user-agent": "ua ann@example.com" } },
    });
    expect(event.transaction).toBe("GET [redacted]");
    expect(event.exception?.values?.[1]?.value).toBe("x [redacted]");
    expect(event.request?.headers).toEqual({ "user-agent": "ua [redacted]" });
  });

  it("fails closed past the depth limit, and survives a cycle", () => {
    let deep: Record<string, unknown> = { customerName: "Ann" };
    for (let i = 0; i < 12; i++) deep = { inner: deep };
    expect(JSON.stringify(scrubEvent({ extra: deep }).extra)).not.toContain("Ann");
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => scrubEvent({ extra: cyclic })).not.toThrow();
  });

  it("masks emails in linear time on a long address-like token", () => {
    const started = performance.now();
    scrubEvent({ message: "a".repeat(100_000) });
    expect(performance.now() - started).toBeLessThan(250);
  });
});
