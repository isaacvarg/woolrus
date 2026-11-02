import { serveManifestPdf } from "@/server/manifests";

// `[id]` is `<manifest id>.pdf`: Next has no suffix segments, so the extension is part of the param.
export async function GET(request: Request, { params }: RouteContext<"/api/manifests/[id]">) {
  return serveManifestPdf(request, (await params).id);
}
