"use client";

import type { ErrorCode } from "@woolrus/i18n";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Form } from "react-aria-components";
import { Button, TextField } from "@/components/ui/fields";
import { authClient } from "@/lib/auth-client";

// Failures come back to this page as `?error=` (see page.tsx).
const callbacks = { callbackURL: "/", errorCallbackURL: "/sign-in" };

/** `initialEmail` comes from an invitation link (`/sign-in?email=…`). */
export function SignInForm({
  initialEmail,
  error,
  providers,
}: {
  initialEmail: string;
  error: ErrorCode | null;
  providers: { google: boolean; discord: boolean };
}) {
  const t = useTranslations();
  const [email, setEmail] = useState(initialEmail);
  const [sent, setSent] = useState(false);
  const social = providers.google || providers.discord;

  return (
    <main className="grid min-h-dvh place-items-center p-4">
      <div className="card w-full max-w-sm bg-base-100 shadow">
        <div className="card-body gap-4">
          <h1 className="card-title text-2xl">{t("common.appName")}</h1>
          {error && (
            <p role="alert" className="alert alert-error">
              {t(error)}
            </p>
          )}
          {providers.google && (
            <Button
              className="btn-outline"
              onPress={() => authClient.signIn.social({ provider: "google", ...callbacks })}
            >
              {t("signIn.withGoogle")}
            </Button>
          )}
          {providers.discord && (
            <Button
              className="btn-outline"
              onPress={() => authClient.signIn.social({ provider: "discord", ...callbacks })}
            >
              {t("signIn.withDiscord")}
            </Button>
          )}
          {social && <div className="divider my-0">{t("signIn.or")}</div>}
          {sent ? (
            <>
              <p role="status">{t("signIn.checkEmail")}</p>
              <Button className="btn-ghost" onPress={() => setSent(false)}>
                {t("signIn.useAnother")}
              </Button>
            </>
          ) : (
            <Form
              onSubmit={async (event) => {
                event.preventDefault();
                // The server answers the same whether or not it sent anything, and so does this page.
                await authClient.signIn.magicLink({ email, ...callbacks });
                setSent(true);
              }}
            >
              <TextField
                label={t("signIn.email")}
                type="email"
                isRequired
                value={email}
                onChange={setEmail}
              />
              <Button type="submit" className="btn-primary mt-2 w-full">
                {t("signIn.emailMe")}
              </Button>
            </Form>
          )}
        </div>
      </div>
    </main>
  );
}
