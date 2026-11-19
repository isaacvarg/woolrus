"use client";

import { useMutation } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/fields";
import { useErrorMessage } from "@/lib/errors";
import { client } from "@/lib/orpc";

/** Full screen and touch first, like the lock screen. Any case, spaces or dashes are fine. */
export function SetupForm({ initialCode }: { initialCode: string }) {
  const t = useTranslations("stationSetup");
  const errorMessage = useErrorMessage();
  const [code, setCode] = useState(initialCode);
  const redeem = useMutation({
    mutationFn: () => client.station.redeemSetupCode({ code }),
    // A full load: the response set the station cookie and ended any personal session.
    onSuccess: () => window.location.assign("/station"),
  });

  // Keep the code out of history (and anything that reads the address bar) once it's in the field.
  useEffect(() => {
    if (window.location.search) window.history.replaceState(null, "", "/station/setup");
  }, []);

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-base-100 p-6 text-center">
      <h1 className="text-4xl font-bold">{t("title")}</h1>
      <p className="text-xl">{t("prompt")}</p>
      <form
        className="flex w-full max-w-md flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (code.trim()) redeem.mutate();
        }}
      >
        <label htmlFor="setup-code" className="text-lg font-semibold">
          {t("code")}
        </label>
        <input
          id="setup-code"
          // biome-ignore lint/a11y/noAutofocus: the page exists to take this one input.
          autoFocus
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={64}
          placeholder="XXXXX-XXXXX"
          className="input input-lg h-16 w-full text-center font-mono text-3xl tracking-widest uppercase"
          value={code}
          disabled={redeem.isPending || redeem.isSuccess}
          onChange={(event) => {
            setCode(event.target.value);
            redeem.reset();
          }}
        />
        <p aria-live="polite" className="min-h-7 text-lg font-semibold text-error">
          {redeem.error ? errorMessage(redeem.error) : null}
        </p>
        <Button
          type="submit"
          className="btn-primary btn-lg h-16 text-xl"
          isPending={redeem.isPending || redeem.isSuccess}
        >
          {t("submit")}
        </Button>
      </form>
      <Link href="/sign-in" className="btn btn-ghost btn-lg">
        {t("back")}
      </Link>
    </main>
  );
}
