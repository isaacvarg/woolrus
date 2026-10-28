import { openApiHandler, withBodyLimit } from "@/server/handlers";
import { traced } from "@/server/request-trace";

async function handle(incoming: Request) {
  return traced(incoming, "/api/v1", (context) =>
    withBodyLimit(incoming, async (request) => {
      const { response } = await openApiHandler.handle(request, { prefix: "/api/v1", context });
      return response ?? new Response("Not found", { status: 404 });
    }),
  );
}

export { handle as DELETE, handle as GET, handle as PATCH, handle as POST, handle as PUT };
