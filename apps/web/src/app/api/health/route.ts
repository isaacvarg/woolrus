import { encryptionKey } from "@woolrus/core";
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
  // Without a valid key, integration secrets can't be stored or read (FR-SET-05).
  checks.encryption = encryptionKey() ? "ok" : "fail";
  const ok = Object.values(checks).every((c) => c === "ok");
  return Response.json({ ok, checks }, { status: ok ? 200 : 503 });
}
