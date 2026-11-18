"use client";

import { useTranslations } from "next-intl";
import { useSyncExternalStore } from "react";

type Params = Record<string, string | readonly string[] | undefined>;

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const noSubscription = () => () => {};

/** `params` as a query string, dropping empty ones and repeating lists. */
export function exportQuery(params: Params): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    for (const one of typeof value === "string" ? [value] : (value ?? [])) {
      if (one) query.append(name, one);
    }
  }
  return query.toString();
}

/**
 * **Export CSV** for a list or report (SPEC-reporting "CSV exports"): downloads `path` with the
 * screen's filters, and the browser's time zone so the file's times read as on screen. Render it
 * only for `report.read` holders; the route checks again.
 */
export function ExportCsvLink({ path, params }: { path: string; params: Params }) {
  const t = useTranslations("exports");
  // The server renders UTC; the browser's zone replaces it on hydration.
  const timeZone = useSyncExternalStore(noSubscription, browserZone, () => "UTC");
  return (
    <a
      className="btn btn-outline"
      href={`${path}?${exportQuery({ ...params, timeZone })}`}
      download
    >
      {t("button")}
    </a>
  );
}
