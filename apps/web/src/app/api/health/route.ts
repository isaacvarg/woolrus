import { emailStatus, encryptionKey, shippingProviderHealth } from "@woolrus/core";
import { db } from "@woolrus/db";
import { storage } from "@/server/storage";

export const dynamic = "force-dynamic";

/** Dependency checks (NFR-OPS-02). WooCommerce and Lumexia join as their adapters land. */
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
  // Creates a missing bucket (first use), then HEAD bucket; 2 s timeout each. Missing env counts as
  // down: attachments can't work without it.
  try {
    checks.storage = await storage().check();
  } catch {
    checks.storage = "fail";
  }
  const ok = Object.values(checks).every((c) => c === "ok");
  // Informational, not part of `ok`: dev runs fine on the log sender, but "unconfigured" in
  // production blocks go-live (SPEC-identity "Email").
  let email: "ok" | "unconfigured" | "fail";
  try {
    email = checks.database === "ok" ? await emailStatus(db) : "fail";
  } catch {
    email = "fail";
  }
  // One entry per shipping provider; an enabled one failing degrades health, it doesn't take it
  // down (SPEC-carriers "Health"). Pings are cached for 5 minutes.
  let shipping: Record<string, "disabled" | "unconfigured" | "ok" | "fail"> = {};
  let degraded = false;
  try {
    if (checks.database === "ok")
      ({ providers: shipping, degraded } = await shippingProviderHealth(db));
  } catch {
    degraded = true;
  }
  return Response.json(
    { ok, degraded, checks: { ...checks, email, shipping } },
    { status: ok ? 200 : 503 },
  );
}
