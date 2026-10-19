"use client";

import { useQuery } from "@tanstack/react-query";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { orpc } from "@/lib/orpc";

/** "n min ago" moves with the clock even when no sync event arrives. */
const REFRESH_MS = 60_000;

/**
 * "Synced 3 min ago" for everyone, red when sync is failing or late (FR-SYNC-07). Order events
 * refetch it too (see `lib/live.ts`), so an import shows up at once.
 */
export function SyncIndicator() {
  const t = useTranslations("sync.indicator");
  const format = useFormatter();
  const now = useNow({ updateInterval: 30_000 });
  const status = useQuery(orpc.sync.status.queryOptions({ refetchInterval: REFRESH_MS }));
  if (!status.data) return null;

  const { stale, lastSuccessAt } = status.data;
  const since = (at: Date) =>
    now.getTime() - at.getTime() < 60_000 ? null : format.relativeTime(at, now);

  if (stale) {
    const label = stale === "failing" ? t("failing") : lastSuccessAt ? t("late") : t("never");
    return (
      <p role="status" className="px-2 text-sm font-semibold text-error">
        {label}
        {lastSuccessAt && (
          <span className="block font-normal">
            {t("lastSuccess", { time: format.relativeTime(lastSuccessAt, now) })}
          </span>
        )}
      </p>
    );
  }

  const time = lastSuccessAt ? since(lastSuccessAt) : null;
  return (
    <p role="status" className="px-2 text-sm text-base-content/70">
      {time ? t("synced", { time }) : t("justNow")}
    </p>
  );
}
