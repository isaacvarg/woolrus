import type { LumexiaClient, LumexiaTypeKind } from "./client";
import { LumexiaAuthError, LumexiaBadResponse, LumexiaUnavailable } from "./errors";
import {
  type LumexiaItem,
  type LumexiaLot,
  lumexiaErrorSchema,
  lumexiaHealthSchema,
  parseLumexia,
  parseLumexiaItem,
  parseLumexiaLot,
  parseLumexiaPage,
  parseLumexiaType,
} from "./schemas";

export type LumexiaConfig = { baseUrl: string; apiKey: string };

export type LumexiaHttpOptions = {
  fetch?: typeof fetch;
  /** Per request (default 5 s). `scanLot` uses a shorter budget: someone is waiting on it. */
  timeoutMs?: number;
};

const TIMEOUT_MS = 5_000;
/** Lumexia's `limit` and repeated-value maximum. */
const MAX = 200;
const SEARCH_LIMIT = 50;

const typeRoutes: Record<LumexiaTypeKind, { path: string; key: string }> = {
  item: { path: "/item-types", key: "itemTypes" },
  procurement: { path: "/procurement-types", key: "procurementTypes" },
  inventory: { path: "/inventory-types", key: "inventoryTypes" },
};

type Params = [string, string][];

/**
 * Lumexia's REST API v1 (docs/lumexia-api.md) over Node `fetch`. Build it with `lumexiaClientFor(db)`.
 * Nothing is retried here: callers in the background have pg-boss retries, and a person waiting
 * gets the answer at once. Errors name the route and status, never the key or query values.
 */
export function createLumexiaClient(
  config: LumexiaConfig,
  options: LumexiaHttpOptions = {},
): LumexiaClient {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const base = apiBase(config.baseUrl);
  const authorization = `Bearer ${config.apiKey}`;

  async function get(route: string, params: Params, allowNotFound: true): Promise<unknown | null>;
  async function get(route: string, params?: Params): Promise<unknown>;
  async function get(route: string, params: Params = [], allowNotFound = false) {
    const path = `${base.pathname}${route}`;
    const url = new URL(path, base);
    for (const [key, value] of params) url.searchParams.append(key, value);
    const what = `GET ${path}`;

    let response: Response;
    try {
      response = await doFetch(url, {
        headers: { authorization, accept: "application/json" },
        // Never follow: a redirect could lead the key to another host, and the API doesn't redirect.
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const reason =
        error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network error";
      throw new LumexiaUnavailable(`${what}: ${reason}`);
    }

    const { status } = response;
    if (status === 429 || status >= 500) {
      // Release the connection; the body is never read.
      response.body?.cancel().catch(() => {});
      throw new LumexiaUnavailable(`${what}: ${status}`, status);
    }
    if (status === 401 || status === 403) {
      response.body?.cancel().catch(() => {});
      throw new LumexiaAuthError(`${what}: ${status}`, status);
    }

    // Every answer of Lumexia's, errors included, is JSON; anything else is another site.
    const isJson = response.headers.get("content-type")?.includes("json") ?? false;
    const body: unknown = isJson
      ? await response.json().catch((error: unknown) => {
          // The timeout covers the body too: a stalled body is Lumexia being slow, not another site.
          if (
            error instanceof Error &&
            (error.name === "TimeoutError" || error.name === "AbortError")
          ) {
            throw new LumexiaUnavailable(`${what}: timeout`);
          }
          return undefined;
        })
      : undefined;
    if (body === undefined) {
      response.body?.cancel().catch(() => {});
      throw new LumexiaBadResponse(`${what}: ${status}, not JSON`, status);
    }
    const code = lumexiaErrorSchema.safeParse(body).data?.error.code;

    if (status === 400) {
      // A request Lumexia refused is our bug, not Lumexia's state: an internal error.
      throw new Error(`Lumexia rejected ${what}: 400${code ? ` ${code}` : ""}`);
    }
    if (status === 404 && allowNotFound && code === "not_found") return null;
    if (status < 200 || status >= 300) {
      throw new LumexiaBadResponse(`${what}: ${status}${code ? ` ${code}` : ""}`, status);
    }
    return body;
  }

  /** Every row of a list route, following `nextCursor`, at 200 a page. */
  async function list<T>(
    route: string,
    key: string,
    params: Params,
    parse: (row: unknown) => T,
  ): Promise<T[]> {
    const rows: T[] = [];
    const seen = new Set<string>();
    for (let cursor: string | null = null; ; ) {
      const page = [...params, ["limit", String(MAX)]] as Params;
      if (cursor) page.push(["cursor", cursor]);
      const body = parseLumexiaPage(await get(route, page), key, `GET ${route}`);
      rows.push(...body.rows.map(parse));
      cursor = body.nextCursor;
      if (cursor === null) return rows;
      if (seen.has(cursor)) throw new LumexiaBadResponse(`GET ${route}: cursor repeated`);
      seen.add(cursor);
    }
  }

  return {
    async ping() {
      parseLumexia(lumexiaHealthSchema, await get("/health"), "GET /health");
    },

    listTypes(kind) {
      const { path, key } = typeRoutes[kind];
      return list(path, key, [], (row) => parseLumexiaType(row, kind === "inventory"));
    },

    async searchItems(q, limit = SEARCH_LIMIT) {
      const capped = Math.min(Math.max(Math.trunc(limit), 1), MAX);
      const params: Params = [
        ["q", q],
        ["limit", String(capped)],
      ];
      const { rows } = parseLumexiaPage(await get("/items", params), "items", "GET /items");
      return rows.map(parseLumexiaItem);
    },

    async findItems(filter) {
      const [param, values] =
        "ids" in filter
          ? (["id", filter.ids] as const)
          : (["reference_code", filter.referenceCodes] as const);
      // A code and an alias of one item can land in different batches: keep each item once.
      const found = new Map<string, LumexiaItem>();
      for (let i = 0; i < values.length; i += MAX) {
        const batch = values.slice(i, i + MAX).map((v): [string, string] => [param, v]);
        for (const item of await list("/items", "items", batch, parseLumexiaItem)) {
          if (!found.has(item.id)) found.set(item.id, item);
        }
      }
      return [...found.values()];
    },

    async getItem(id) {
      const body = await get(`/items/${encodeURIComponent(id)}`, [], true);
      return body === null ? null : parseLumexiaItem(body);
    },

    async getLot(id): Promise<LumexiaLot | null> {
      const body = await get(`/lots/${encodeURIComponent(id)}`, [], true);
      return body === null ? null : parseLumexiaLot(body);
    },

    findLotsByNumber(lotNumber) {
      return list("/lots", "lots", [["lot_number", lotNumber]], parseLumexiaLot);
    },
  };
}

/** `<origin>[/prefix]/api/v1`, whether or not the saved URL already ends in `/api/v1`. */
function apiBase(baseUrl: string): URL {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/api/v1") ? path : `${path}/api/v1`;
  url.search = "";
  url.hash = "";
  return url;
}
