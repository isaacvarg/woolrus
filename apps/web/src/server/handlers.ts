import { OpenAPIGenerator } from "@orpc/openapi";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { RPCHandler } from "@orpc/server/fetch";
import { ResponseHeadersPlugin } from "@orpc/server/plugins";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { contract, NOTE_REQUEST_MAX_BYTES } from "@woolrus/contracts";
import { createLogger } from "@woolrus/logger";
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

/**
 * Caps a request body (note uploads are the largest): a declared length over `max` gets 413 at
 * once, and a body that streams past it errors, so a client can't fill the server's memory.
 */
export function capRequestBody(request: Request, max = NOTE_REQUEST_MAX_BYTES): Request | Response {
  if (Number(request.headers.get("content-length") ?? 0) > max) {
    return new Response(null, { status: 413 });
  }
  if (!request.body) return request;
  let seen = 0;
  const body = request.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > max) controller.error(new Error("request body too large"));
        else controller.enqueue(chunk);
      },
    }),
  );
  // From the URL: Next's request objects aren't accepted as `new Request(request, …)` input.
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    signal: request.signal,
    body,
    duplex: "half",
  } as RequestInit);
}
