/** Browser error events are a few tens of KB; this leaves room for a long stack and breadcrumbs. */
export const TUNNEL_MAX_BYTES = 100 * 1024;

/** What a browser reports; attachments and session replays are never forwarded. */
const ALLOWED_ITEMS = new Set(["event", "transaction", "session", "sessions", "client_report"]);

/** Envelopes forwarded per minute, all callers together: a flood can't fill GlitchTip's quota. */
export const TUNNEL_MAX_PER_MINUTE = 120;
let window = { startedAt: 0, count: 0 };

/** Forget the rate window (tests). */
export function resetTunnelLimit(): void {
  window = { startedAt: 0, count: 0 };
}

function withinLimit(now = Date.now()): boolean {
  if (now - window.startedAt >= 60_000) window = { startedAt: now, count: 0 };
  window.count += 1;
  return window.count <= TUNNEL_MAX_PER_MINUTE;
}

type IngestTarget = { origin: string; projectId: string };

function targetOf(dsn: string): IngestTarget | null {
  try {
    const url = new URL(dsn);
    const projectId = url.pathname.split("/").filter(Boolean).pop();
    return projectId ? { origin: url.origin, projectId } : null;
  } catch {
    return null;
  }
}

/** The body, or null once it passes `max` bytes, without buffering more than that. */
async function readCapped(request: Request, max: number): Promise<Buffer | null> {
  if (Number(request.headers.get("content-length")) > max) return null;
  if (!request.body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request.body) {
    size += chunk.byteLength;
    if (size > max) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** More items than a browser ever sends in one envelope. */
const MAX_ITEMS = 20;

/**
 * True when every item in the envelope is of an allowed type. Walks item headers, framing the
 * payload by `length` when the header has one (a non-negative integer, or the envelope is refused)
 * and by the next newline when it doesn't. The position must advance each step, so a hostile
 * header can't make this loop.
 */
function onlyAllowedItems(body: Buffer): boolean {
  let at = body.indexOf(10) + 1; // past the envelope header line
  if (at === 0) return false;
  for (let items = 0; at < body.length; items++) {
    if (items >= MAX_ITEMS) return false;
    const headerEnd = body.indexOf(10, at);
    const headerLine = body.subarray(at, headerEnd === -1 ? body.length : headerEnd);
    const header = JSON.parse(headerLine.toString("utf8")) as { type?: unknown; length?: unknown };
    if (typeof header.type !== "string" || !ALLOWED_ITEMS.has(header.type)) return false;
    if (header.length !== undefined && !Number.isSafeInteger(header.length)) return false;
    const length = header.length as number | undefined;
    if (length !== undefined && length < 0) return false;
    if (headerEnd === -1) return true;
    const start = headerEnd + 1;
    const lineEnd = body.indexOf(10, start);
    const end = length !== undefined ? start + length : lineEnd === -1 ? body.length : lineEnd;
    const next = end + 1;
    if (next <= at) return false;
    at = next;
  }
  return true;
}

/**
 * The browser SDK's tunnel (SPEC-operations "Tunnel"). Forwards an envelope to GlitchTip only when
 * the DSN in its first line names the configured host and project, so it isn't an open relay, and
 * at most `TUNNEL_MAX_PER_MINUTE` a minute.
 * Never throws and never says why: the caller answers 204 whatever happens here.
 */
export async function forwardErrorEnvelope(
  request: Request,
  configuredDsn: string | undefined,
  send: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const configured = configuredDsn ? targetOf(configuredDsn) : null;
    if (!configured) return false;
    const body = await readCapped(request, TUNNEL_MAX_BYTES);
    if (!body) return false;
    const firstLine = body.toString("utf8").split("\n", 1)[0] ?? "";
    const dsn = (JSON.parse(firstLine) as { dsn?: unknown }).dsn;
    const sent = typeof dsn === "string" ? targetOf(dsn) : null;
    if (!sent || sent.origin !== configured.origin || sent.projectId !== configured.projectId) {
      return false;
    }
    // Only an envelope that names our project counts against the limit, so junk can't starve it.
    if (!onlyAllowedItems(body) || !withinLimit()) return false;
    const response = await send(`${configured.origin}/api/${configured.projectId}/envelope/`, {
      method: "POST",
      headers: { "content-type": "application/x-sentry-envelope" },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
