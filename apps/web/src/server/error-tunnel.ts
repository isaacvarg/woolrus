export const TUNNEL_MAX_BYTES = 1024 * 1024;

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

/**
 * The browser SDK's tunnel (SPEC-operations "Tunnel"). Forwards an envelope to GlitchTip only when
 * the DSN in its first line names the configured host and project, so it isn't an open relay.
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
