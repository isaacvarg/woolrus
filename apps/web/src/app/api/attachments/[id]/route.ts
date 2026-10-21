import { serveAttachment } from "@/server/attachments";

export async function GET(request: Request, { params }: RouteContext<"/api/attachments/[id]">) {
  return serveAttachment(request, (await params).id, "full");
}
