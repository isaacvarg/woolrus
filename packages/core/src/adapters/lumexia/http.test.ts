import { describe, expect, it } from "vitest";
import error400 from "./__fixtures__/error-400.json" with { type: "json" };
import error401 from "./__fixtures__/error-401.json" with { type: "json" };
import error403 from "./__fixtures__/error-403.json" with { type: "json" };
import error404 from "./__fixtures__/error-404.json" with { type: "json" };
import error500 from "./__fixtures__/error-500.json" with { type: "json" };
import health from "./__fixtures__/health.json" with { type: "json" };
import inventoryTypes from "./__fixtures__/inventory-types.json" with { type: "json" };
import item from "./__fixtures__/item.json" with { type: "json" };
import itemTypes from "./__fixtures__/item-types.json" with { type: "json" };
import items from "./__fixtures__/items.json" with { type: "json" };
import lot from "./__fixtures__/lot.json" with { type: "json" };
import lots from "./__fixtures__/lots.json" with { type: "json" };
import procurementTypes from "./__fixtures__/procurement-types.json" with { type: "json" };
import type { LumexiaClient } from "./client";
import { describeLumexiaClient, type LumexiaWorld, type SimulatedFailure } from "./contract";
import { LumexiaAuthError, LumexiaBadResponse, LumexiaUnavailable } from "./errors";
import { matchItems, matchLots } from "./fake";
import { createLumexiaClient, type LumexiaHttpOptions } from "./http";

const config = { baseUrl: "https://lumexia.example.test", apiKey: "lmx_test_key_123" };

type Reply = Response | Error | "hang";
type Call = { url: URL; init: RequestInit };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

/** Never answers; rejects when the client's timeout aborts it, as `fetch` does. */
const hang = (init: RequestInit | undefined) =>
  new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  });

/** A client whose fetch answers from `replies` in order (the last one repeats). */
function setup(...replies: Reply[]) {
  return setupWith({}, ...replies);
}

function setupWith(options: LumexiaHttpOptions & { baseUrl?: string }, ...replies: Reply[]) {
  const calls: Call[] = [];
  const client = createLumexiaClient(
    { ...config, baseUrl: options.baseUrl ?? config.baseUrl },
    {
      timeoutMs: 50,
      fetch: async (input, init) => {
        calls.push({ url: new URL(String(input)), init: init ?? {} });
        const reply = replies[Math.min(calls.length - 1, replies.length - 1)] as Reply;
        if (reply === "hang") return hang(init);
        if (reply instanceof Error) throw reply;
        return reply.clone();
      },
      ...options,
    },
  );
  return { client, calls };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a failure");
    },
    (e: unknown) => e,
  );
}

const header = (call: Call | undefined, name: string) => new Headers(call?.init.headers).get(name);

describe("Lumexia HTTP client", () => {
  describe("routes, on the fixtures", () => {
    it("pings /api/v1/health with the bearer key", async () => {
      const { client, calls } = setup(json(health));
      await client.ping();
      expect(calls[0]?.url.href).toBe("https://lumexia.example.test/api/v1/health");
      expect(header(calls[0], "authorization")).toBe("Bearer lmx_test_key_123");
      expect(header(calls[0], "accept")).toBe("application/json");
      expect(calls[0]?.init.redirect).toBe("manual");
    });

    it("keeps a path prefix, and doesn't double an /api/v1 already in the URL", async () => {
      for (const baseUrl of [
        "https://erp.example.test/lumexia/",
        "https://erp.example.test/lumexia/api/v1",
      ]) {
        const { client, calls } = setupWith({ baseUrl }, json(health));
        await client.ping();
        expect(calls[0]?.url.href).toBe("https://erp.example.test/lumexia/api/v1/health");
      }
    });

    it("refuses a health answer that isn't Lumexia's", async () => {
      const { client } = setup(json({ ok: true }));
      expect(await failure(client.ping())).toBeInstanceOf(LumexiaBadResponse);
    });

    it("maps each type list, 200 per page", async () => {
      const { client, calls } = setup(
        json(itemTypes),
        json(procurementTypes),
        json(inventoryTypes),
      );
      expect(await client.listTypes("item")).toEqual(itemTypes.itemTypes);
      expect(await client.listTypes("procurement")).toEqual(procurementTypes.procurementTypes);
      expect(await client.listTypes("inventory")).toEqual(inventoryTypes.inventoryTypes);
      expect(calls.map((c) => `${c.url.pathname}${c.url.search}`)).toEqual([
        "/api/v1/item-types?limit=200",
        "/api/v1/procurement-types?limit=200",
        "/api/v1/inventory-types?limit=200",
      ]);
    });

    it("follows nextCursor until it is null", async () => {
      const [first, second, third] = itemTypes.itemTypes;
      const { client, calls } = setup(
        json({ itemTypes: [first], nextCursor: "c1" }),
        json({ itemTypes: [second], nextCursor: "c2" }),
        json({ itemTypes: [third], nextCursor: null }),
      );
      expect(await client.listTypes("item")).toEqual([first, second, third]);
      expect(calls.map((c) => c.url.searchParams.get("cursor"))).toEqual([null, "c1", "c2"]);
    });

    it("refuses a cursor that repeats, instead of looping", async () => {
      const { client } = setup(json({ itemTypes: [], nextCursor: "same" }));
      expect(await failure(client.listTypes("item"))).toBeInstanceOf(LumexiaBadResponse);
    });

    it("searches one page with q and the limit, capped at 200", async () => {
      const { client, calls } = setup(json(items));
      const found = await client.searchItems("lav");
      expect(found.map((i) => i.referenceCode)).toEqual(["BASE1234", "BASE9999", "BOX-SM"]);
      expect(found[0]?.updatedAt).toEqual(new Date("2026-11-09T14:03:00.000Z"));
      await client.searchItems("lav", 500);
      expect(calls.map((c) => c.url.search)).toEqual(["?q=lav&limit=50", "?q=lav&limit=200"]);
    });

    it("finds items by repeated reference_code or id, 200 values per request", async () => {
      const codes = Array.from({ length: 450 }, (_, i) => `SKU${i}`);
      const { client, calls } = setup(json(items), json({ items: [], nextCursor: null }));
      await client.findItems({ referenceCodes: codes });
      expect(calls.map((c) => c.url.searchParams.getAll("reference_code").length)).toEqual([
        200, 200, 50,
      ]);
      expect(calls[2]?.url.searchParams.getAll("reference_code")).toEqual(codes.slice(400));
      expect(calls.every((c) => c.url.searchParams.get("limit") === "200")).toBe(true);

      const byId = setup(json(items));
      await byId.client.findItems({ ids: ["a", "b"] });
      expect(byId.calls[0]?.url.search).toBe("?id=a&id=b&limit=200");
    });

    it("returns each found item once across batches, and asks nothing for no values", async () => {
      const codes = Array.from({ length: 201 }, (_, i) => `SKU${i}`);
      const { client, calls } = setup(json(items));
      expect(await client.findItems({ referenceCodes: codes })).toHaveLength(3);
      expect(calls).toHaveLength(2);

      const none = setup(json(items));
      expect(await none.client.findItems({ ids: [] })).toEqual([]);
      expect(none.calls).toHaveLength(0);
    });

    it("gets one item, escaping the id", async () => {
      const { client, calls } = setup(json(item));
      expect(await client.getItem(item.id)).toMatchObject({
        id: item.id,
        referenceCode: "BASE1234",
      });
      await client.getItem("a/b?c");
      expect(calls[1]?.url.pathname).toBe("/api/v1/items/a%2Fb%3Fc");
    });

    it("gets one lot, and finds lots by number", async () => {
      const { client, calls } = setup(json(lot), json(lots));
      expect(await client.getLot(lot.id)).toMatchObject({
        lotNumber: "BASE1234.A12A0124",
        createdAt: new Date("2024-01-01T09:00:00.000Z"),
      });
      expect(await client.findLotsByNumber("BASE1234.A12A0124")).toHaveLength(3);
      expect(calls.map((c) => `${c.url.pathname}${c.url.search}`)).toEqual([
        `/api/v1/lots/${lot.id}`,
        "/api/v1/lots?lot_number=BASE1234.A12A0124&limit=200",
      ]);
    });

    it("returns null on a 404 and [] on an empty list", async () => {
      const { client } = setup(
        json(error404, 404),
        json(error404, 404),
        json({ lots: [], nextCursor: null }),
      );
      expect(await client.getItem("missing")).toBeNull();
      expect(await client.getLot("missing")).toBeNull();
      expect(await client.findLotsByNumber("BASE0000.A00A0000")).toEqual([]);
    });
  });

  describe("errors", () => {
    const cases: [string, Reply, unknown][] = [
      ["401", json(error401, 401), LumexiaAuthError],
      ["403", json(error403, 403), LumexiaAuthError],
      [
        "429",
        json({ error: { code: "rate_limited", message: "Slow down" } }, 429),
        LumexiaUnavailable,
      ],
      ["500", json(error500, 500), LumexiaUnavailable],
      [
        "502 from a proxy, as HTML",
        new Response("<html>Bad gateway</html>", { status: 502 }),
        LumexiaUnavailable,
      ],
      ["a network error", new TypeError("fetch failed"), LumexiaUnavailable],
      ["a timeout", "hang", LumexiaUnavailable],
      [
        "an HTML page",
        new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }),
        LumexiaBadResponse,
      ],
      [
        "a redirect",
        new Response(null, { status: 302, headers: { location: "http://10.0.0.1/" } }),
        LumexiaBadResponse,
      ],
      ["a 404 on a list route", json(error404, 404), LumexiaBadResponse],
      [
        "a 404 that isn't Lumexia's",
        new Response("Not found", { status: 404 }),
        LumexiaBadResponse,
      ],
      [
        "a row of the wrong shape",
        json({ items: [{ id: 1 }], nextCursor: null }),
        LumexiaBadResponse,
      ],
    ];

    for (const [what, reply, type] of cases) {
      it(`raises ${(type as { name: string }).name} on ${what}`, async () => {
        const { client } = setup(reply);
        const error = await failure(
          what.includes("404") && !what.includes("list")
            ? client.getItem("x")
            : client.findItems({ referenceCodes: ["X"] }),
        );
        expect(error).toBeInstanceOf(type);
        expect(String((error as Error).message)).not.toContain(config.apiKey);
      });
    }

    it("throws a 400 as an internal error with Lumexia's code, not a Lumexia failure", async () => {
      const { client } = setup(json(error400, 400));
      const error = await failure(client.listTypes("item"));
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(LumexiaUnavailable);
      expect(error).not.toBeInstanceOf(LumexiaAuthError);
      expect(error).not.toBeInstanceOf(LumexiaBadResponse);
      expect((error as Error).message).toBe(
        "Lumexia rejected GET /api/v1/item-types: 400 invalid_request",
      );
    });

    it("keeps query values out of error messages", async () => {
      const { client } = setup(json(error500, 500));
      const error = (await failure(client.findItems({ referenceCodes: ["SECRET-SKU"] }))) as Error;
      expect(error.message).toBe("GET /api/v1/items: 500");
    });
  });
});

/**
 * A Lumexia answering from `world` in the documented shapes, at most `pageSize` rows a page, so
 * the contract runs the real client over paging, filters and errors.
 */
function serve(world: LumexiaWorld, apiKey: string, pageSize = 2) {
  const failures: SimulatedFailure[] = [];
  const page = (key: string, rows: unknown[], url: URL) => {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), pageSize);
    const start = Number(url.searchParams.get("cursor") ?? 0);
    const end = start + limit;
    return json({
      [key]: rows.slice(start, end),
      nextCursor: end < rows.length ? String(end) : null,
    });
  };
  const notFound = () => json(error404, 404);

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const failure = failures.shift();
    if (failure === "network") throw new TypeError("fetch failed");
    if (failure === "timeout") return hang(init);
    if (failure !== undefined) {
      const body = {
        400: error400,
        401: error401,
        403: error403,
        429: error500,
        500: error500,
        503: error500,
      };
      return json(body[failure], failure);
    }
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${apiKey}`) {
      return json(error401, 401);
    }
    const route = url.pathname.replace(/^\/api\/v1/, "");
    const params = url.searchParams;
    const [, resource, id] = route.split("/");
    if (route === "/health") return json(health);
    if (route === "/item-types") return page("itemTypes", world.itemTypes, url);
    if (route === "/procurement-types")
      return page("procurementTypes", world.procurementTypes, url);
    if (route === "/inventory-types") return page("inventoryTypes", world.inventoryTypes, url);
    if (resource === "items" && id) {
      return found(world.items.find((i) => i.id === decodeURIComponent(id))) ?? notFound();
    }
    if (resource === "lots" && id) {
      return found(world.lots.find((l) => l.id === decodeURIComponent(id))) ?? notFound();
    }
    if (route === "/items") {
      const has = (key: string) => params.has(key);
      const matched = matchItems(world.items, {
        q: params.get("q") ?? undefined,
        referenceCodes: has("reference_code") ? params.getAll("reference_code") : undefined,
        ids: has("id") ? params.getAll("id") : undefined,
      });
      return page("items", matched, url);
    }
    if (route === "/lots") {
      return page(
        "lots",
        matchLots(world.lots, { lotNumber: params.get("lot_number") ?? undefined }),
        url,
      );
    }
    return notFound();
  };
  return { fetch, failNext: (f: SimulatedFailure) => failures.push(f) };
}

// `json(undefined)` would send a body; a missing record is a 404.
function found<T>(row: T | undefined): Response | undefined {
  return row === undefined ? undefined : json(row);
}

describeLumexiaClient("Lumexia HTTP client", (world) => {
  const server = serve(world, config.apiKey);
  const client: LumexiaClient = createLumexiaClient(config, { fetch: server.fetch, timeoutMs: 50 });
  return { client, failNext: server.failNext, secrets: [config.apiKey] };
});

// Opt-in: run a dev Lumexia (on :3100, say: Woolrus web has :3000), create a read-only key under
// Settings → User → Agents, then
// `LUMEXIA_LIVE=1 LUMEXIA_BASE_URL=http://localhost:3100 LUMEXIA_API_KEY=lmx_… pnpm --filter @woolrus/core test -- adapters/lumexia`.
// Checks that the fixtures' shapes are what Lumexia really sends: every route parses.
describe.skipIf(!process.env.LUMEXIA_LIVE)("Lumexia HTTP client against a dev Lumexia", () => {
  const live = createLumexiaClient({
    baseUrl: process.env.LUMEXIA_BASE_URL || "http://localhost:3100",
    apiKey: process.env.LUMEXIA_API_KEY || "",
  });

  it("pings and lists the three type tables", async () => {
    await live.ping();
    for (const kind of ["item", "procurement", "inventory"] as const) {
      const types = await live.listTypes(kind);
      expect(types.length).toBeGreaterThan(0);
      if (kind === "inventory")
        expect(types.every((t) => typeof t.isTracked === "boolean")).toBe(true);
    }
  });

  it("searches, finds and gets items, and resolves their lots both ways", async () => {
    const [first] = await live.searchItems("", 5);
    expect(first).toBeDefined();
    if (!first) return;
    expect(await live.getItem(first.id)).toEqual(first);
    expect((await live.findItems({ ids: [first.id] })).map((i) => i.id)).toEqual([first.id]);
    expect(
      (await live.findItems({ referenceCodes: [first.referenceCode] })).map((i) => i.id),
    ).toContain(first.id);
    expect(await live.getItem(crypto.randomUUID())).toBeNull();

    expect(await live.findLotsByNumber(`${first.referenceCode}.A00A0000`)).toEqual([]);
    expect(await live.getLot(crypto.randomUUID())).toBeNull();
  });

  it("resolves a real lot by id and by number", async () => {
    // The client has no "any lot" route, so take one straight from the API.
    const base = (process.env.LUMEXIA_BASE_URL || "http://localhost:3100").replace(/\/+$/, "");
    const response = await fetch(`${base}/api/v1/lots?limit=1`, {
      headers: { authorization: `Bearer ${process.env.LUMEXIA_API_KEY}` },
    });
    const { lots } = (await response.json()) as { lots: { id: string; lotNumber: string }[] };
    const [any] = lots;
    if (!any) return;
    const byId = await live.getLot(any.id);
    expect(byId).toMatchObject({ id: any.id, lotNumber: any.lotNumber });
    expect((await live.findLotsByNumber(any.lotNumber)).map((l) => l.id)).toContain(any.id);
  });
});
