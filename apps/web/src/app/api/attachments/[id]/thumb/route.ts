import { serveAttachment } from "@/server/attachments";

export async function GET(
  request: Request,
  { params }: RouteContext<"/api/attachments/[id]/thumb">,
) {
  return serveAttachment(request, (await params).id, "thumb");
}
