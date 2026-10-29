import { PII_KEYS } from "./pii";

const PII = new Set<string>(PII_KEYS);
const MAX_DEPTH = 8;

/** Copy of `value` with the value of every PII key, at any depth, replaced by `[redacted]`. */
function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      PII.has(key) ? "[redacted]" : redactDeep(item, depth + 1),
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
  breadcrumbs?: { message?: string; data?: Record<string, unknown> }[];
  exception?: { values?: { value?: string }[] };
};

const EMAIL = /[^\s@<>"']+@[\w-]+(?:\.[\w-]+)+/g;
const maskEmails = (text: string) => text.replace(EMAIL, "[redacted]");

/**
 * A URL without its query string and fragment: staff search orders by customer name or email, and
 * the search term travels in the query. Relative URLs stay relative.
 */
const stripQuery = (url: string) => url.split(/[?#]/, 1)[0] ?? url;
const URL_KEYS = ["url", "from", "to"];

function scrubCrumbData(data: Record<string, unknown>): Record<string, unknown> {
  const redacted = redactDeep(data) as Record<string, unknown>;
  for (const key of URL_KEYS) {
    const value = redacted[key];
    if (typeof value === "string") redacted[key] = stripQuery(value);
  }
  return redacted;
}

/**
 * The shared `beforeSend` for error reports (SPEC-operations "Error tracking"): drops request
 * bodies, cookies, query strings and the authorization header, strips queries from URLs, and redacts PII keys in `extra` and `contexts`.
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
      Object.entries(headers ?? {}).filter(
        ([name]) => !["authorization", "cookie", "set-cookie"].includes(name.toLowerCase()),
      ),
    );
    scrubbed.request = {
      ...request,
      ...(url === undefined ? {} : { url: stripQuery(url) }),
      ...(headers ? { headers: kept } : {}),
    } as T["request"];
  }
  if (event.message !== undefined) scrubbed.message = maskEmails(event.message);
  if (event.transaction !== undefined) scrubbed.transaction = stripQuery(event.transaction);
  if (event.extra) scrubbed.extra = redactDeep(event.extra) as T["extra"];
  if (event.contexts) scrubbed.contexts = redactDeep(event.contexts) as T["contexts"];
  if (event.breadcrumbs) {
    scrubbed.breadcrumbs = event.breadcrumbs.map((crumb) => ({
      ...crumb,
      ...(crumb.message === undefined ? {} : { message: maskEmails(crumb.message) }),
      ...(crumb.data === undefined ? {} : { data: scrubCrumbData(crumb.data) }),
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
