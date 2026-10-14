"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { Form } from "react-aria-components";
import { Button, TextField } from "@/components/ui/fields";
import { authClient } from "@/lib/auth-client";

export default function SignInPage() {
  const t = useTranslations("common");
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);

  return (
    <main className="grid min-h-dvh place-items-center p-4">
      <div className="card w-full max-w-sm bg-base-100 shadow">
        <div className="card-body gap-4">
          <h1 className="card-title text-2xl">{t("appName")}</h1>
          <Button
            className="btn-outline"
            onPress={() => authClient.signIn.social({ provider: "google", callbackURL: "/" })}
          >
            Google
          </Button>
          <div className="divider my-0" />
          {sent ? (
            <p role="status">Check your email for a sign-in link.</p>
          ) : (
            <Form
              onSubmit={async (event) => {
                event.preventDefault();
                await authClient.signIn.magicLink({ email, callbackURL: "/" });
                setSent(true);
              }}
            >
              <TextField label="Email" type="email" isRequired value={email} onChange={setEmail} />
              <Button type="submit" className="btn-primary mt-2 w-full">
                Email me a link
              </Button>
            </Form>
          )}
        </div>
      </div>
    </main>
  );
}
