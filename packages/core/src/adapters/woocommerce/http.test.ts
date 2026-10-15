import { describe, expect, it } from "vitest";
import error401 from "./__fixtures__/error-401.json" with { type: "json" };
import error404 from "./__fixtures__/error-404.json" with { type: "json" };
import errorNoRoute from "./__fixtures__/error-no-route.json" with { type: "json" };
import orders from "./__fixtures__/orders.json" with { type: "json" };
import products from "./__fixtures__/products.json" with { type: "json" };
import dimensionUnit from "./__fixtures__/setting-dimension-unit.json" with { type: "json" };
import weightUnit from "./__fixtures__/setting-weight-unit.json" with { type: "json" };
import variations from "./__fixtures__/variations-12.json" with { type: "json" };
import { StoreError, type StoreErrorKind, storeErrorMessageKey } from "./errors";
import { createStoreAdapter, type StoreRequestLog } from "./http";

const config = {
  url: "https://shop.example.test/",
  consumerKey: "ck_test_key_123",
  consumerSecret: "cs_test_secret_456",
};

type Reply = Response | Error;
type Call = { url: URL; init: RequestInit };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=UTF-8", ...headers },
  });
const html = (status: number) =>
  new Response("<!doctype html><title>Not here</title>", {
    status,
    headers: { "content-type": "text/html; charset=UTF-8" },
  });

/** An adapter whose fetch answers from `replies` in order (the last one repeats). */
function setup(...replies: Reply[]) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const logs: StoreRequestLog[] = [];
  const adapter = createStoreAdapter(config, {
    fetch: async (input, init) => {
      calls.push({ url: new URL(String(input)), init: init ?? {} });
      const reply = replies[Math.min(calls.length - 1, replies.length - 1)] as Reply;
      if (reply instanceof Error) throw reply;
      return reply.clone();
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    log: (entry) => logs.push(entry),
  });
  return { adapter, calls, sleeps, logs };
}

async function kindOf(promise: Promise<unknown>): Promise<StoreErrorKind> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(StoreError);
  return (error as StoreError).kind;
}

describe("WooCommerce HTTP adapter", () => {
  it("lists orders with basic auth, GMT dates, 100 per page and the page count", async () => {
    const { adapter, calls } = setup(json(orders, 200, { "X-WP-TotalPages": "3" }));
    const result = await adapter.listOrders({
      status: "processing",
      modifiedAfter: new Date("2026-10-14T20:54:28.123Z"),
      page: 2,
    });

    expect(result.totalPages).toBe(3);
    expect(result.orders.map((o) => o.id)).toEqual([17, 16, 15]);

    const call = calls[0] as Call;
    expect(call.url.origin + call.url.pathname).toBe(
      "https://shop.example.test/wp-json/wc/v3/orders",
    );
    expect(Object.fromEntries(call.url.searchParams)).toEqual({
      per_page: "100",
      page: "2",
      dates_are_gmt: "true",
      status: "processing",
      modified_after: "2026-10-14T20:54:28",
    });
    const auth = new Headers(call.init.headers).get("authorization");
    expect(auth).toBe(
      `Basic ${Buffer.from("ck_test_key_123:cs_test_secret_456").toString("base64")}`,
    );
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("lists orders by id with include=", async () => {
    const { adapter, calls } = setup(json([orders[0]]));
    const result = await adapter.listOrders({ include: [17, 3], page: 1 });
    expect(result.totalPages).toBe(1);
    expect(calls[0]?.url.searchParams.get("include")).toBe("17,3");
  });

  it("gets one order, or null when the store says it doesn't exist", async () => {
    expect((await setup(json(orders[2])).adapter.getOrder(15))?.number).toBe("15");
    expect(await setup(json(error404, 404)).adapter.getOrder(99999)).toBeNull();
  });

  it("fetches products by id in batches of 100", async () => {
    const { adapter, calls } = setup(json(products));
    const ids = Array.from({ length: 150 }, (_, i) => i + 1);
    const result = await adapter.getProducts(ids);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url.searchParams.get("include")?.split(",")).toHaveLength(100);
    expect(calls[1]?.url.searchParams.get("include")?.split(",")).toHaveLength(50);
    expect(result).toHaveLength(6);
    expect(await setup().adapter.getProducts([])).toEqual([]);
  });

  it("pages through every variation of a product", async () => {
    const { adapter, calls } = setup(
      json([variations[0]], 200, { "X-WP-TotalPages": "2" }),
      json([variations[1]], 200, { "X-WP-TotalPages": "2" }),
    );
    const result = await adapter.listVariations(12);
    expect(result.map((v) => v.id)).toEqual([14, 13]);
    expect(calls.map((c) => c.url.pathname)).toEqual([
      "/wp-json/wc/v3/products/12/variations",
      "/wp-json/wc/v3/products/12/variations",
    ]);
    expect(calls.map((c) => c.url.searchParams.get("page"))).toEqual(["1", "2"]);
  });

  it("reads the store's weight and dimension units", async () => {
    const { adapter, calls } = setup(json(weightUnit), json(dimensionUnit));
    expect(await adapter.getUnits()).toEqual({ weight: "lbs", dimension: "in" });
    expect(calls.map((c) => c.url.pathname)).toEqual([
      "/wp-json/wc/v3/settings/products/woocommerce_weight_unit",
      "/wp-json/wc/v3/settings/products/woocommerce_dimension_unit",
    ]);
  });

  it("refuses a unit it can't convert", async () => {
    const { adapter } = setup(json({ ...weightUnit, value: "stone" }));
    expect(await kindOf(adapter.getUnits())).toBe("badResponse");
  });

  it("pings the v3 index and an authenticated endpoint", async () => {
    const { adapter, calls } = setup(json({ namespace: "wc/v3", routes: {} }), json([]));
    await adapter.ping();
    expect(calls.map((c) => c.url.pathname)).toEqual(["/wp-json/wc/v3", "/wp-json/wc/v3/orders"]);
  });

  describe("retries", () => {
    it("retries a 429 after the Retry-After delay, then succeeds", async () => {
      const { adapter, calls, sleeps } = setup(
        json({ code: "too_many" }, 429, { "Retry-After": "7" }),
        json(orders),
      );
      const result = await adapter.listOrders({ page: 1 });
      expect(result.orders).toHaveLength(3);
      expect(calls).toHaveLength(2);
      expect(sleeps).toEqual([7000]);
    });

    it("backs off exponentially on 5xx and gives up after 3 retries", async () => {
      const { adapter, calls, sleeps } = setup(html(503));
      expect(await kindOf(adapter.listOrders({ page: 1 }))).toBe("unreachable");
      expect(calls).toHaveLength(4);
      expect(sleeps).toEqual([500, 1000, 2000]);
    });

    it("reports rateLimited when 429 persists, and caps a huge Retry-After", async () => {
      const { adapter, sleeps } = setup(json({}, 429, { "Retry-After": "3600" }));
      expect(await kindOf(adapter.listOrders({ page: 1 }))).toBe("rateLimited");
      expect(sleeps).toEqual([60_000, 60_000, 60_000]);
    });

    it("retries network failures and timeouts, then reports unreachable", async () => {
      const timeout = new DOMException("The operation timed out.", "TimeoutError");
      const { adapter, calls } = setup(new TypeError("fetch failed"), timeout);
      expect(await kindOf(adapter.listOrders({ page: 1 }))).toBe("unreachable");
      expect(calls).toHaveLength(4);
    });

    it("does not retry a 401", async () => {
      const { adapter, calls } = setup(json(error401, 401));
      expect(await kindOf(adapter.listOrders({ page: 1 }))).toBe("unauthorized");
      expect(calls).toHaveLength(1);
    });
  });

  describe("errors", () => {
    it.each([
      ["401", json(error401, 401), "unauthorized"],
      ["403", json({ code: "woocommerce_rest_cannot_view" }, 403), "unauthorized"],
      ["404 HTML page", html(404), "notWooCommerce"],
      [
        "404 rest_no_route (WordPress without WooCommerce)",
        json(errorNoRoute, 404),
        "notWooCommerce",
      ],
      ["200 HTML page", html(200), "notWooCommerce"],
      ["a body that fails the schema", json([{ id: "not a number" }]), "badResponse"],
      ["a 400", json({ code: "rest_invalid_param" }, 400), "badResponse"],
    ] as const)("maps %s to %s", async (_label, reply, kind) => {
      expect(await kindOf(setup(reply).adapter.listOrders({ page: 1 }))).toBe(kind);
    });

    it("reports a non-WooCommerce site on ping", async () => {
      expect(await kindOf(setup(html(200)).adapter.ping())).toBe("notWooCommerce");
      expect(await kindOf(setup(json({ namespace: "wp/v2" })).adapter.ping())).toBe(
        "notWooCommerce",
      );
    });

    it("reports wrong credentials on ping", async () => {
      const { adapter } = setup(json({ namespace: "wc/v3", routes: {} }), json(error401, 401));
      expect(await kindOf(adapter.ping())).toBe("unauthorized");
    });

    it("maps every kind to an errors.sync message key", () => {
      expect(storeErrorMessageKey("unauthorized")).toBe("errors.sync.unauthorized");
      expect(new StoreError("unreachable").messageKey).toBe("errors.sync.unreachable");
    });
  });

  describe("logging", () => {
    it("logs method, path, status and duration for every attempt", async () => {
      const { adapter, logs } = setup(json({}, 429, { "Retry-After": "1" }), json(orders));
      await adapter.listOrders({ page: 1 });
      expect(logs).toHaveLength(2);
      expect(logs[0]).toMatchObject({
        method: "GET",
        path: "/wp-json/wc/v3/orders",
        status: 429,
        attempt: 1,
      });
      expect(logs[1]).toMatchObject({ status: 200, attempt: 2 });
      expect(typeof logs[1]?.durationMs).toBe("number");
    });

    it("never logs or throws credentials or customer data", async () => {
      const basic = Buffer.from(`${config.consumerKey}:${config.consumerSecret}`).toString(
        "base64",
      );
      const forbidden = [
        config.consumerKey,
        config.consumerSecret,
        basic,
        "ana@example.test",
        "Lopez",
      ];
      const outcomes: unknown[] = [];
      const logs: StoreRequestLog[] = [];

      for (const reply of [
        json(orders),
        json(error401, 401),
        html(503),
        new TypeError("fetch failed"),
      ]) {
        const run = setup(reply);
        outcomes.push(await run.adapter.listOrders({ page: 1 }).catch((e: unknown) => e));
        logs.push(...run.logs);
      }

      const errors = outcomes.filter((o) => o instanceof Error) as Error[];
      expect(errors).toHaveLength(3);
      const text =
        JSON.stringify(logs) + errors.map((e) => `${e.message} ${JSON.stringify(e)}`).join();
      for (const value of forbidden) expect(text).not.toContain(value);
    });
  });
});

// Opt-in: `WOO_LIVE=1 pnpm --filter @woolrus/core test -- adapters/woocommerce` with `pnpm stack:up`.
describe.skipIf(!process.env.WOO_LIVE)("WooCommerce HTTP adapter against the dev store", () => {
  const live = createStoreAdapter({
    url: process.env.WOO_URL || "http://localhost:8090",
    consumerKey: process.env.WOO_CONSUMER_KEY || "ck_woolrus_dev_key",
    consumerSecret: process.env.WOO_CONSUMER_SECRET || "cs_woolrus_dev_secret",
  });

  it("pings, reads units and lists one page of orders", async () => {
    await live.ping();
    expect(await live.getUnits()).toEqual({ weight: "lbs", dimension: "in" });
    const page = await live.listOrders({ page: 1 });
    expect(page.totalPages).toBeGreaterThanOrEqual(1);
    expect(page.orders.length).toBeGreaterThan(0);
  });
});
