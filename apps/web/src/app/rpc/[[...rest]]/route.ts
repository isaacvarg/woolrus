import { capRequestBody, requestContext, rpcHandler } from "@/server/handlers";

async function handle(incoming: Request) {
  const request = capRequestBody(incoming);
  if (request instanceof Response) return request;
  const { response } = await rpcHandler.handle(request, {
    prefix: "/rpc",
    context: requestContext(request),
  });
  return response ?? new Response("Not found", { status: 404 });
}

export { handle as GET, handle as POST };
