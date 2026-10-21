import { requestContext, rpcHandler, withBodyLimit } from "@/server/handlers";

async function handle(incoming: Request) {
  return withBodyLimit(incoming, async (request) => {
    const { response } = await rpcHandler.handle(request, {
      prefix: "/rpc",
      context: requestContext(request),
    });
    return response ?? new Response("Not found", { status: 404 });
  });
}

export { handle as GET, handle as POST };
