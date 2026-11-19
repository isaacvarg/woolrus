"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { StationSetupCodeIssued } from "@woolrus/contracts";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/fields";
import { orpc } from "@/lib/orpc";

/** How often the open dialog looks for the new station. */
const WATCH_MS = 2_000;

/** Milliseconds until `at`, rechecked every second; never below 0. */
export function useTimeLeft(at: Date): number {
  const left = () => Math.max(0, at.getTime() - Date.now());
  const [ms, setMs] = useState(left);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `left` only reads `at`.
  useEffect(() => {
    setMs(left());
    const timer = setInterval(() => setMs(left()), 1_000);
    return () => clearInterval(timer);
  }, [at]);
  return ms;
}

/** `9:05`: minutes and seconds, rounded up so it shows 0:00 only once the time is up. */
export function formatTimeLeft(ms: number): string {
  const seconds = Math.ceil(ms / 1_000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * The issued code in the Add station dialog (SPEC-identity A3): the QR, the code and a countdown.
 * It watches the stations list and says "<name> is set up" once the tablet has redeemed it; at zero
 * it says the code expired and offers a new one.
 */
export function SetupCode({
  issued,
  onDone,
  onRenew,
  renewing,
  renewError,
}: {
  issued: StationSetupCodeIssued;
  onDone: () => void;
  onRenew: () => void;
  renewing: boolean;
  renewError: string | null;
}) {
  const t = useTranslations();
  const timeLeft = useTimeLeft(issued.expiresAt);
  const stations = useQuery({
    ...orpc.stations.list.queryOptions(),
    // Stations stay listed once made (revoked ones too), so this stays true once it's set up.
    refetchInterval: (query) =>
      query.state.data?.some((station) => station.name === issued.name) || timeLeft === 0
        ? false
        : WATCH_MS,
  });
  const setUp = stations.data?.some((station) => station.name === issued.name) ?? false;
  const expired = timeLeft === 0 && !setUp;
  // The code is used now: the open codes listed behind the dialog are out of date.
  const queryClient = useQueryClient();
  useEffect(() => {
    if (setUp) queryClient.invalidateQueries({ queryKey: orpc.stations.setupCodes.key() });
  }, [setUp, queryClient]);

  if (setUp) {
    return (
      <>
        <p role="status" className="text-2xl font-bold">
          {t("stations.setupCodeSetUp", { name: issued.name })}
        </p>
        <p>{t("stations.setupCodeSetUpBody")}</p>
        <div className="modal-action">
          <Button onPress={onDone}>{t("stations.done")}</Button>
        </div>
      </>
    );
  }

  if (expired) {
    return (
      <>
        <p role="status">{t("stations.setupCodeExpired", { name: issued.name })}</p>
        {renewError && (
          <p role="alert" className="text-error">
            {renewError}
          </p>
        )}
        <div className="modal-action">
          <Button className="btn-ghost" onPress={onDone}>
            {t("common.cancel")}
          </Button>
          <Button isPending={renewing} onPress={onRenew}>
            {t("stations.setupCodeRenew")}
          </Button>
        </div>
      </>
    );
  }

  return (
    <>
      <p>{t("stations.setupCodeBody")}</p>
      <div className="flex flex-col items-center gap-2 rounded-box border border-base-300 p-4">
        <div
          role="img"
          aria-label={t("stations.setupCodeQr", { name: issued.name })}
          className="w-56 [&>svg]:h-auto [&>svg]:w-full"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: SVG made by `qrcode` on our server from a link we built; no user input.
          dangerouslySetInnerHTML={{ __html: issued.qrSvg }}
        />
        <p className="text-sm opacity-70">{t("stations.setupCodeLabel")}</p>
        <p data-testid="setup-code" className="font-mono text-4xl font-bold tracking-widest">
          {issued.code}
        </p>
        <p className="tabular-nums" data-testid="setup-code-time-left">
          {t("stations.setupCodeTimeLeft", { time: formatTimeLeft(timeLeft) })}
        </p>
      </div>
      <div className="modal-action">
        <Button onPress={onDone}>{t("stations.done")}</Button>
      </div>
    </>
  );
}
