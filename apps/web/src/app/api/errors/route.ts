import { forwardErrorEnvelope } from "@/server/error-tunnel";

/**
 * The browser SDK's tunnel to GlitchTip (SPEC-operations "Tunnel"). No session: errors on the
 * sign-in page count too. Answers 204 whether or not the envelope was forwarded.
 */
export async function POST(request: Request) {
  await forwardErrorEnvelope(request, process.env.SENTRY_DSN);
  return new Response(null, { status: 204 });
}
