import { db } from "@woolrus/db";

export const dynamic = "force-dynamic";

/** Dependency checks (NFR-OPS-02). Storage, WooCommerce, ShipStation and Lumexia join as their adapters land. */
export async function GET() {
  const checks: Record<string, "ok" | "fail"> = {};
  try {
    await db.$queryRaw`SELECT 1`;
    checks.database = "ok";
  } catch {
    checks.database = "fail";
  }
  const ok = Object.values(checks).every((c) => c === "ok");
  return Response.json({ ok, checks }, { status: ok ? 200 : 503 });
}
