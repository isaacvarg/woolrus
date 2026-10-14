import { generateOpenApiSpec } from "@/server/handlers";

export async function GET() {
  return Response.json(await generateOpenApiSpec());
}
