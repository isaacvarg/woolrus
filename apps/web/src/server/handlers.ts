import { OpenAPIGenerator } from "@orpc/openapi";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { RPCHandler } from "@orpc/server/fetch";
import { ResponseHeadersPlugin } from "@orpc/server/plugins";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { contract, NOTE_REQUEST_MAX_BYTES } from "@woolrus/contracts";
import { createLogger } from "@woolrus/logger";
import { resolveActor } from "./actor";
import { router } from "./router";

/** RPC protocol, used by the web app's typed client at /rpc. */
// ResponseHeadersPlugin gives procedures `context.resHeaders`, for the cookies they set.
export const rpcHandler = new RPCHandler(router, { plugins: [new ResponseHeadersPlugin()] });

/** REST + OpenAPI at /api/v1, for the Android client and anything else. */
export const openApiHandler = new OpenAPIHandler(router, {
  plugins: [new ResponseHeadersPlugin()],
});

export const openApiGenerator = new OpenAPIGenerator({
  schemaConverters: [new ZodToJsonSchemaConverter()],
});

export function generateOpenApiSpec() {
  return openApiGenerator.generate(contract, {
    info: { title: "Woolrus API", version: "1.0.0" },
    servers: [{ url: "/api/v1" }],
    components: {
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer" },
        cookie: { type: "apiKey", in: "cookie", name: "better-auth.session_token" },
      },
    },
    security: [{ bearer: [] }, { cookie: [] }],
  });
}

export function requestContext(request: Request) {
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  return { headers: request.headers, log: createLogger({ requestId }) };
}

/** Every call but a note upload: JSON inputs are small. */
const DEFAULT_MAX_BYTES = 1024 * 1024;

/** The procedures that take files: `notes.create` and `notes.update`, over RPC and REST. */
function isNoteUpload(request: Request): boolean {
  const { pathname } = new URL(request.url);
  if (request.method === "POST" && /^\/rpc\/notes\/(create|update)$/.test(pathname)) return true;
  if (request.method === "POST" && /^\/api\/v1\/orders\/[^/]+\/notes$/.test(pathname)) return true;
  return request.method === "PATCH" && /^\/api\/v1\/notes\/[^/]+$/.test(pathname);
}

/** The same request with no body: oRPC still routes it, and `authed` answers as for any call. */
function withoutBody(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.delete("content-type");
  headers.delete("transfer-encoding");
  return new Request(request.url, { method: request.method, headers, signal: request.signal });
}

/**
 * Runs an API request with a cap on its body, because oRPC reads and parses the whole body before
 * any middleware, auth included. A note upload gets 160 MB, and only once the caller is known: a
 * signed-out one is answered without reading its body. Everything else gets 1 MB. A declared
 * length over the cap is refused at once; a body that streams past it stops there and gets 413.
 */
export async function withBodyLimit(
  incoming: Request,
  run: (request: Request) => Promise<Response>,
): Promise<Response> {
  const upload = isNoteUpload(incoming);
  if (upload && !(await resolveActor(incoming.headers))) {
    incoming.body?.cancel().catch(() => {});
    return run(withoutBody(incoming));
  }
  const max = upload ? NOTE_REQUEST_MAX_BYTES : DEFAULT_MAX_BYTES;
  if (Number(incoming.headers.get("content-length") ?? 0) > max) {
    return new Response(null, { status: 413 });
  }
  if (!incoming.body) return run(incoming);

  let seen = 0;
  let overflowed = false;
  const body = incoming.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > max) {
          overflowed = true;
          controller.error(new Error("request body too large"));
        } else controller.enqueue(chunk);
      },
    }),
  );
  // From the URL: Next's request objects aren't accepted as `new Request(request, …)` input.
  const request = new Request(incoming.url, {
    method: incoming.method,
    headers: incoming.headers,
    signal: incoming.signal,
    body,
    duplex: "half",
  } as RequestInit);
  const response = await run(request);
  // oRPC answers a body that failed mid-read with its own parse error; the cause was the size.
  return overflowed ? new Response(null, { status: 413 }) : response;
}
