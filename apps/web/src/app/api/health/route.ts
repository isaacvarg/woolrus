import {
  emailStatus,
  encryptionKey,
  fakeShippingProviders,
  shippingProviderHealth,
  woocommerceHealth,
} from "@woolrus/core";
import { db } from "@woolrus/db";
import { storage } from "@/server/storage";

export const dynamic = "force-dynamic";

/** Dependency checks (NFR-OPS-02). Lumexia joins as its adapter lands. */
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
  // An enabled shipping provider failing degrades health, it doesn't take it down (SPEC-carriers
  // "Health"). This endpoint is public, so it says only whether; admins see which provider on
  // Settings → Shipping. Fake providers in production degrade it too: labels would be fake.
  let degraded = process.env.NODE_ENV === "production" && fakeShippingProviders();
  try {
    if (checks.database === "ok") degraded ||= (await shippingProviderHealth(db)).degraded;
  } catch {
    degraded = true;
  }
  // A broken store degrades health, it doesn't take it down: the floor keeps working on the orders
  // already imported (SPEC-operations "Health"). Says only ok/fail, never why or which host.
  let woocommerce: "ok" | "fail" | "unconfigured" = "fail";
  try {
    if (checks.database === "ok") woocommerce = await woocommerceHealth(db);
  } catch {
    woocommerce = "fail";
  }
  degraded ||= woocommerce === "fail";
  return Response.json(
    { ok, degraded, checks: { ...checks, email, woocommerce } },
    { status: ok ? 200 : 503 },
  );
}
