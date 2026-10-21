import { capRequestBody, openApiHandler, requestContext } from "@/server/handlers";

async function handle(incoming: Request) {
  const request = capRequestBody(incoming);
  if (request instanceof Response) return request;
  const { response } = await openApiHandler.handle(request, {
    prefix: "/api/v1",
    context: requestContext(request),
  });
  return response ?? new Response("Not found", { status: 404 });
}

export { handle as DELETE, handle as GET, handle as PATCH, handle as POST, handle as PUT };
