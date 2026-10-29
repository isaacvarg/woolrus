import { isPiiKey, maskEmails } from "./pii";

const MAX_DEPTH = 8;
const REDACTED = "[redacted]";

/** A URL without userinfo, query string and fragment: staff search orders by customer name or email. */
function stripUrl(url: string): string {
  const bare = url.split(/[?#]/, 1)[0] ?? url;
  return bare.replace(/^((?:[a-z][a-z\d+.-]*:)?\/\/)[^/\\]*@/i, "$1");
}

const looksLikeUrl = (text: string) => /^(?:[a-z][a-z\d+.-]*:)?\/\/|^\//i.test(text);

/** Masks emails in a string, and strips the query from it if it is a URL. */
const scrubText = (text: string) => maskEmails(looksLikeUrl(text) ? stripUrl(text) : text);

/**
 * Copy of `value` where the value of every PII key, at any depth, is replaced by `[redacted]` and
 * every other string is passed through `scrubText`. Fails closed: anything nested deeper than
 * `MAX_DEPTH` is replaced too, and a cycle ends at that depth.
 */
function redactDeep(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return scrubText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      isPiiKey(key) ? REDACTED : redactDeep(item, depth + 1),
    ]),
  );
}

/** The parts of a Sentry event that `scrubEvent` touches; the SDK's own event types satisfy it. */
export type ScrubbableEvent = {
  request?: {
    url?: string;
    query_string?: unknown;
    data?: unknown;
    cookies?: unknown;
    headers?: Record<string, string>;
  };
  message?: string;
  transaction?: string;
  extra?: Record<string, unknown>;
  contexts?: object;
  tags?: Record<string, unknown>;
  breadcrumbs?: { message?: string; data?: Record<string, unknown> }[];
  exception?: { values?: { value?: string }[] };
};

/** The only request headers that leave the process: the rest can carry the page URL or client addresses. */
const KEPT_HEADERS = new Set(["user-agent", "content-type", "accept-language", "x-request-id"]);

/**
 * The shared `beforeSend` for error reports (SPEC-operations "Error tracking"). Drops request
 * bodies, cookies, query strings and every request header but a short allowlist; strips queries and
 * userinfo from URLs; masks emails in every string; and redacts PII keys in `extra`, `contexts`,
 * `tags` and breadcrumb data.
 */
export function scrubEvent<T extends ScrubbableEvent>(event: T): T {
  const scrubbed: T = { ...event };
  if (event.request) {
    const {
      data: _data,
      cookies: _cookies,
      query_string: _query,
      headers,
      url,
      ...request
    } = event.request;
    const kept = Object.fromEntries(
      Object.entries(headers ?? {}).filter(([name]) => KEPT_HEADERS.has(name.toLowerCase())),
    );
    scrubbed.request = {
      ...request,
      ...(url === undefined ? {} : { url: stripUrl(url) }),
      ...(headers ? { headers: kept } : {}),
    } as T["request"];
  }
  if (event.message !== undefined) scrubbed.message = scrubText(event.message);
  if (event.transaction !== undefined) scrubbed.transaction = stripUrl(event.transaction);
  if (event.extra) scrubbed.extra = redactDeep(event.extra) as T["extra"];
  if (event.contexts) scrubbed.contexts = redactDeep(event.contexts) as T["contexts"];
  if (event.tags) scrubbed.tags = redactDeep(event.tags) as T["tags"];
  if (event.breadcrumbs) {
    scrubbed.breadcrumbs = event.breadcrumbs.map((crumb) => ({
      ...crumb,
      ...(crumb.message === undefined ? {} : { message: scrubText(crumb.message) }),
      ...(crumb.data === undefined
        ? {}
        : { data: redactDeep(crumb.data) as Record<string, unknown> }),
    }));
  }
  if (event.exception?.values) {
    scrubbed.exception = {
      ...event.exception,
      values: event.exception.values.map((v) =>
        v.value === undefined ? v : { ...v, value: maskEmails(v.value) },
      ),
    };
  }
  return scrubbed;
}
