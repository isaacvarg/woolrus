"use client";

import { useMutation } from "@tanstack/react-query";
import type { StationStatus, UnlockTile } from "@woolrus/contracts";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/fields";
import { useErrorMessage } from "@/lib/errors";
import { orpc } from "@/lib/orpc";

const PIN_LENGTH = 6;
const PAD = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

/**
 * Tap your name and enter your PIN, or scan your badge (SPEC-identity "UI"). A HID scanner types
 * the code and Enter into whatever has focus, so the badge input keeps it while no name is chosen.
 */
export function LockScreen({ status }: { status: StationStatus }) {
  const t = useTranslations("station");
  const errorMessage = useErrorMessage();
  const [chosen, setChosen] = useState<UnlockTile | null>(null);
  const [pin, setPin] = useState("");
  const [badge, setBadge] = useState("");
  const [error, setError] = useState<string | null>(null);
  const badgeInput = useRef<HTMLInputElement>(null);
  const pinInput = useRef<HTMLInputElement>(null);

  const options = {
    // A full load: nothing cached for the previous user survives the switch.
    onSuccess: () => window.location.assign("/"),
    onError: (err: unknown) => setError(errorMessage(err)),
  };
  const unlockPin = useMutation(orpc.station.unlockPin.mutationOptions(options));
  const unlockBadge = useMutation(orpc.station.unlockBadge.mutationOptions(options));
  const pending = unlockPin.isPending || unlockBadge.isPending;

  useEffect(() => {
    (chosen ? pinInput : badgeInput).current?.focus();
  }, [chosen]);

  const choose = (tile: UnlockTile | null) => {
    setChosen(tile);
    setPin("");
    setError(null);
  };

  const enter = (next: string) => {
    const digits = next.replace(/\D/g, "").slice(0, PIN_LENGTH);
    setPin(digits);
    setError(null);
    if (chosen && digits.length === PIN_LENGTH) {
      unlockPin.mutate({ userId: chosen.id, pin: digits }, { onError: () => setPin("") });
    }
  };

  return (
    <main className="flex min-h-dvh flex-col items-center gap-6 bg-base-100 p-6 text-center">
      <header className="flex flex-col gap-2 pt-6">
        <p className="text-lg opacity-70">
          {status.activeUserName ? t("activeUser", { name: status.activeUserName }) : t("locked")}
        </p>
        <h1 className="text-5xl font-bold">{status.name}</h1>
        <p className="text-xl">{t("prompt")}</p>
        {status.activeUserName && (
          <Link href="/" className="btn btn-ghost btn-lg">
            {t("keepWorking", { name: status.activeUserName })}
          </Link>
        )}
      </header>

      <p aria-live="polite" className="min-h-7 text-lg font-semibold text-error">
        {error}
      </p>

      {chosen ? (
        <section className="flex w-full max-w-sm flex-col items-center gap-4">
          <label htmlFor="pin" className="text-2xl font-semibold">
            {t("enterPin", { name: chosen.name })}
          </label>
          <input
            ref={pinInput}
            id="pin"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={PIN_LENGTH}
            value={pin}
            disabled={pending}
            onChange={(e) => enter(e.target.value)}
            className="input input-lg w-full text-center text-3xl tracking-[0.5em]"
          />
          <div className="grid w-full grid-cols-3 gap-3">
            {PAD.map((digit) => (
              <Button
                key={digit}
                className="btn-outline h-20 text-3xl"
                isDisabled={pending}
                onPress={() => enter(pin + digit)}
              >
                {digit}
              </Button>
            ))}
            <Button className="btn-ghost h-20" isDisabled={pending} onPress={() => enter("")}>
              {t("clear")}
            </Button>
            <Button
              className="btn-outline h-20 text-3xl"
              isDisabled={pending}
              onPress={() => enter(`${pin}0`)}
            >
              0
            </Button>
            <Button
              className="btn-ghost h-20"
              isDisabled={pending}
              onPress={() => enter(pin.slice(0, -1))}
            >
              {t("backspace")}
            </Button>
          </div>
          <Button className="btn-ghost btn-lg" onPress={() => choose(null)}>
            {t("cancel")}
          </Button>
        </section>
      ) : (
        <>
          <section className="flex w-full max-w-4xl flex-col gap-4">
            <h2 className="text-2xl font-semibold">{t("choose")}</h2>
            {status.tiles.length === 0 ? (
              <p className="text-lg">{t("noTiles")}</p>
            ) : (
              <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                {status.tiles.map((tile) => (
                  <li key={tile.id}>
                    <Button
                      className="btn-outline flex h-28 w-full flex-col gap-1"
                      onPress={() => choose(tile)}
                    >
                      <span aria-hidden className="text-3xl font-bold">
                        {tile.initials}
                      </span>
                      <span className="text-lg">{tile.name}</span>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <form
            className="flex flex-col items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              const code = badge.trim();
              setBadge("");
              if (code) unlockBadge.mutate({ code });
            }}
          >
            <label htmlFor="badge" className="text-sm opacity-70">
              {t("badge")}
            </label>
            {/* Takes focus back when nothing else needs it, so a scan always lands here. */}
            <input
              ref={badgeInput}
              id="badge"
              type="password"
              autoComplete="off"
              value={badge}
              disabled={pending}
              onChange={(e) => setBadge(e.target.value)}
              onBlur={(e) => {
                const input = e.currentTarget;
                if (!e.relatedTarget) setTimeout(() => input.focus(), 0);
              }}
              className="input input-sm w-64 text-center"
            />
          </form>
        </>
      )}
    </main>
  );
}
