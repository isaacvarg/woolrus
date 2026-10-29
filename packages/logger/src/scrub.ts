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
  request?: { data?: unknown; cookies?: unknown; headers?: Record<string, string> };
  extra?: Record<string, unknown>;
  contexts?: object;
};

/**
 * The shared `beforeSend` for error reports (SPEC-operations "Error tracking"): drops request
 * bodies, cookies and the authorization header, and redacts PII keys in `extra` and `contexts`.
 */
export function scrubEvent<T extends ScrubbableEvent>(event: T): T {
  const scrubbed: T = { ...event };
  if (event.request) {
    const { data: _data, cookies: _cookies, headers, ...request } = event.request;
    const kept = Object.fromEntries(
      Object.entries(headers ?? {}).filter(
        ([name]) => !["authorization", "cookie", "set-cookie"].includes(name.toLowerCase()),
      ),
    );
    scrubbed.request = { ...request, ...(headers ? { headers: kept } : {}) } as T["request"];
  }
  if (event.extra) scrubbed.extra = redactDeep(event.extra) as T["extra"];
  if (event.contexts) scrubbed.contexts = redactDeep(event.contexts) as T["contexts"];
  return scrubbed;
}
