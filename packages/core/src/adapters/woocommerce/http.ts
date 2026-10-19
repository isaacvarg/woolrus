import {
  type DimensionUnit,
  dimensionUnits,
  type StoreAdapter,
  type WeightUnit,
  weightUnits,
} from "./adapter";
import { StoreError, type StoreErrorKind } from "./errors";
import { parseOrder, parseProduct, parseVariation } from "./schemas";

export type StoreConfig = { url: string; consumerKey: string; consumerSecret: string };

/** One HTTP attempt, for server logs. Deliberately has no room for headers, query or bodies. */
export type StoreRequestLog = {
  method: "GET";
  path: string;
  status: number | null;
  durationMs: number;
  attempt: number;
  error?: StoreErrorKind;
};

export type StoreHttpOptions = {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (entry: StoreRequestLog) => void;
  timeoutMs?: number;
  /** Retries of 429, 5xx and network failures (default 3). 0 when someone is waiting on the answer. */
  retries?: number;
};

const PER_PAGE = 100;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;
const MAX_RETRY_AFTER_MS = 60_000;

type Params = Record<string, string | number | undefined>;
type Reply = { body: unknown; headers: Headers };

/** WooCommerce REST v3 over Node `fetch`. Build it from `getIntegrationConfig(db).woocommerce`. */
export function createStoreAdapter(
  config: StoreConfig,
  options: StoreHttpOptions = {},
): StoreAdapter {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = options.log ?? (() => {});
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxRetries = options.retries ?? MAX_RETRIES;

  const base = new URL(config.url);
  const apiPath = `${base.pathname.replace(/\/+$/, "")}/wp-json/wc/v3`;
  const authorization = `Basic ${Buffer.from(`${config.consumerKey}:${config.consumerSecret}`).toString("base64")}`;

  async function get(
    route: string,
    params: Params,
    opts: { allowNotFound: true },
  ): Promise<Reply | null>;
  async function get(route: string, params?: Params): Promise<Reply>;
  async function get(
    route: string,
    params: Params = {},
    opts: { allowNotFound?: boolean } = {},
  ): Promise<Reply | null> {
    const path = `${apiPath}${route}`;
    const url = new URL(path, base);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    for (let attempt = 1; ; attempt++) {
      const started = performance.now();
      const entry = (status: number | null, error?: StoreErrorKind) =>
        log({
          method: "GET",
          path,
          status,
          durationMs: Math.round(performance.now() - started),
          attempt,
          ...(error ? { error } : {}),
        });
      const retry = attempt <= maxRetries;
      const backoff = BASE_BACKOFF_MS * 2 ** (attempt - 1);

      let response: Response;
      try {
        response = await doFetch(url, {
          headers: { authorization, accept: "application/json" },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        entry(null, "unreachable");
        if (retry) {
          await sleep(backoff);
          continue;
        }
        const reason =
          error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network error";
        throw new StoreError("unreachable", `GET ${path}: ${reason}`);
      }

      const { status } = response;
      if (status === 429 || status >= 500) {
        const kind = status === 429 ? "rateLimited" : "unreachable";
        entry(status, kind);
        // Release the connection; not awaited, the body is never read.
        response.body?.cancel().catch(() => {});
        if (retry) {
          await sleep(retryAfterMs(response.headers.get("retry-after")) ?? backoff);
          continue;
        }
        throw new StoreError(kind, `GET ${path}: ${status}`, status);
      }

      const fail = (kind: StoreErrorKind): never => {
        entry(status, kind);
        throw new StoreError(kind, `GET ${path}: ${status}`, status);
      };
      if (status === 401 || status === 403) return fail("unauthorized");

      // A WooCommerce answer is always JSON; an HTML page means some other site is at that URL.
      const isJson = response.headers.get("content-type")?.includes("json") ?? false;
      const body: unknown = isJson ? await response.json().catch(() => undefined) : undefined;
      if (!isJson) return fail("notWooCommerce");
      if (body === undefined) return fail("badResponse");

      if (status === 404) {
        if (errorCode(body) === "rest_no_route") return fail("notWooCommerce");
        if (opts.allowNotFound) {
          entry(status);
          return null;
        }
        return fail("notFound");
      }
      if (status < 200 || status >= 300) return fail("badResponse");

      entry(status);
      return { body, headers: response.headers };
    }
  }

  const list = (body: unknown, what: string): unknown[] => {
    if (!Array.isArray(body)) throw new StoreError("badResponse", `${what}: expected a list`);
    return body;
  };
  const totalPages = (headers: Headers) => {
    const n = Number(headers.get("x-wp-totalpages"));
    return Number.isInteger(n) && n > 0 ? n : 1;
  };
  const unit = async <T extends string>(name: string, allowed: readonly T[]): Promise<T> => {
    const { body } = await get(`/settings/products/${name}`);
    const value = (body as { value?: unknown } | null)?.value;
    if (typeof value === "string" && (allowed as readonly string[]).includes(value))
      return value as T;
    throw new StoreError("badResponse", `${name}: unsupported unit`);
  };

  return {
    async ping() {
      const { body } = await get("");
      if ((body as { namespace?: unknown } | null)?.namespace !== "wc/v3") {
        throw new StoreError("notWooCommerce", `GET ${apiPath}: no wc/v3 index`);
      }
      await get("/orders", { per_page: 1, _fields: "id" });
    },

    async getUnits() {
      const weight: WeightUnit = await unit("woocommerce_weight_unit", weightUnits);
      const dimension: DimensionUnit = await unit("woocommerce_dimension_unit", dimensionUnits);
      return { weight, dimension };
    },

    async listOrders(q) {
      const { body, headers } = await get("/orders", {
        per_page: PER_PAGE,
        page: q.page,
        dates_are_gmt: "true",
        status: q.status,
        modified_after: q.modifiedAfter && wooGmt(q.modifiedAfter),
        include: q.include?.join(","),
      });
      return { orders: list(body, "orders").map(parseOrder), totalPages: totalPages(headers) };
    },

    async getOrder(id) {
      const reply = await get(`/orders/${id}`, {}, { allowNotFound: true });
      return reply && parseOrder(reply.body);
    },

    async getProducts(ids) {
      const products = [];
      for (let i = 0; i < ids.length; i += PER_PAGE) {
        const batch = ids.slice(i, i + PER_PAGE);
        const { body } = await get("/products", { per_page: PER_PAGE, include: batch.join(",") });
        products.push(...list(body, "products").map(parseProduct));
      }
      return products;
    },

    async listProducts(page) {
      const { body, headers } = await get("/products", { per_page: PER_PAGE, page });
      return {
        products: list(body, "products").map(parseProduct),
        totalPages: totalPages(headers),
      };
    },

    async listVariations(productId) {
      const variations = [];
      for (let page = 1, pages = 1; page <= pages; page++) {
        const { body, headers } = await get(`/products/${productId}/variations`, {
          per_page: PER_PAGE,
          page,
        });
        variations.push(...list(body, "variations").map(parseVariation));
        pages = totalPages(headers);
      }
      return variations;
    },
  };
}

/** `Retry-After` as seconds or an HTTP date, capped so a hostile value can't stall a run. */
function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS) : null;
}

function errorCode(body: unknown): unknown {
  return typeof body === "object" && body !== null ? (body as { code?: unknown }).code : undefined;
}

/** Woo reads `modified_after` as GMT when `dates_are_gmt=true`, without a zone or millis. */
function wooGmt(date: Date): string {
  return date.toISOString().slice(0, 19);
}
