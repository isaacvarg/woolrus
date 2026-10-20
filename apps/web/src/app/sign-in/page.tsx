import type { ErrorCode } from "@woolrus/i18n";
import { env } from "@/server/env";
import { SignInForm } from "./sign-in-form";

/**
 * Better Auth sends failed sign-ins back here with `?error=<code>`. Our session hook refusing a
 * deactivated user is the only way session creation fails, so those two codes mean exactly that.
 */
function errorKey(code: string | undefined): ErrorCode | null {
  if (!code) return null;
  switch (code) {
    case "failed_to_create_session":
    case "unable_to_create_session":
      return "errors.auth.deactivated";
    case "INVALID_TOKEN":
    case "EXPIRED_TOKEN":
      return "errors.auth.linkInvalid";
    default:
      return "errors.auth.signInFailed";
  }
}

export default async function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  const { email, error } = await searchParams;
  const e = env();
  return (
    <SignInForm
      initialEmail={typeof email === "string" ? email : ""}
      error={errorKey(typeof error === "string" ? error : undefined)}
      providers={{
        google: Boolean(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET),
        discord: Boolean(e.DISCORD_CLIENT_ID && e.DISCORD_CLIENT_SECRET),
      }}
    />
  );
}
