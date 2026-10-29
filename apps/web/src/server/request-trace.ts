import { createLogger, type Logger } from "@woolrus/logger";
import { captureServerError } from "./error-reporting";

/** Filled in as the call learns more; read when it finishes. */
export type RequestTrace = { userId?: string; stationId?: string };

export type RequestContext = {
  headers: Headers;
  log: Logger;
  trace: RequestTrace;
};

/** The id that ties a call's log lines to its audit rows; `requestContext` always sets it. */
export function requestIdOf(headers: Headers): string | undefined {
  return headers.get("x-request-id") ?? undefined;
}

/** A caller's id is kept only if it is short and plain; otherwise it could flood logs and audit rows. */
const SAFE_REQUEST_ID = /^[\w.-]{1,128}$/;

/**
 * The context for one API call. Its headers carry the request id (the caller's `x-request-id`, or a
 * new one), so `resolveActor` can put it on the Actor and audit rows record it.
 */
export function requestContext(request: Request): RequestContext {
  const sent = request.headers.get("x-request-id");
  const requestId = sent && SAFE_REQUEST_ID.test(sent) ? sent : crypto.randomUUID();
  const headers = new Headers(request.headers);
  headers.set("x-request-id", requestId);
  return { headers, log: createLogger({ requestId }), trace: {} };
}

/**
 * Runs an API call and logs one line when it finishes (NFR-OPS-01): procedure, status, duration,
 * requestId, userId; `error` level for 5xx. The response carries `x-request-id`.
 */
export async function traced(
  request: Request,
  prefix: string,
  run: (context: RequestContext) => Promise<Response>,
  root: Logger = createLogger({ module: "http" }),
): Promise<Response> {
  const context = requestContext(request);
  const requestId = requestIdOf(context.headers);
  const started = performance.now();
  let response: Response;
  let failure: unknown;
  try {
    response = await run(context);
  } catch (err) {
    failure = err;
    captureServerError(err, {
      requestId,
      userId: context.trace.userId,
      stationId: context.trace.stationId,
    });
    response = new Response(null, { status: 500 });
  }
  const status = response.status;
  const procedure = new URL(request.url).pathname.slice(prefix.length + 1);
  root[status >= 500 ? "error" : "info"](
    {
      procedure,
      status,
      durationMs: Math.round(performance.now() - started),
      requestId,
      userId: context.trace.userId,
      ...(failure === undefined ? {} : { err: failure }),
    },
    "request",
  );
  try {
    response.headers.set("x-request-id", requestId ?? "");
    return response;
  } catch {
    // Immutable headers (a fetched or redirect response): copy.
    const copy = new Response(response.body, response);
    copy.headers.set("x-request-id", requestId ?? "");
    return copy;
  }
}
