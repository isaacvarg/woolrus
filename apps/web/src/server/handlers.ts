import { OpenAPIGenerator } from "@orpc/openapi";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { RPCHandler } from "@orpc/server/fetch";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { contract } from "@woolrus/contracts";
import { createLogger } from "@woolrus/logger";
import { router } from "./router";

/** RPC protocol, used by the web app's typed client at /rpc. */
export const rpcHandler = new RPCHandler(router);

/** REST + OpenAPI at /api/v1, for the Android client and anything else. */
export const openApiHandler = new OpenAPIHandler(router);

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
