import { rpcHandler, withBodyLimit } from "@/server/handlers";
import { traced } from "@/server/request-trace";

async function handle(incoming: Request) {
  return traced(incoming, "/rpc", (context) =>
    withBodyLimit(incoming, async (request) => {
      const { response } = await rpcHandler.handle(request, { prefix: "/rpc", context });
      return response ?? new Response("Not found", { status: 404 });
    }),
  );
}

export { handle as GET, handle as POST };
