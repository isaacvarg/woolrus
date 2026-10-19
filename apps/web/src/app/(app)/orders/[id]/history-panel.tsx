"use client";

import { useQuery } from "@tanstack/react-query";
import type { OrderHistoryEntry } from "@woolrus/contracts";
import { useFormatter, useTranslations } from "next-intl";
import { useId } from "react";
import { useErrorMessage } from "@/lib/errors";
import { orpc } from "@/lib/orpc";
import { useReasonText } from "@/lib/reasons";

/** Who moved the order, when and why (FR-WF-05), newest first. */
export function HistoryPanel({ id }: { id: string }) {
  const t = useTranslations();
  const format = useFormatter();
  const errorMessage = useErrorMessage();
  const reasonText = useReasonText();
  const headingId = useId();
  const history = useQuery(orpc.orders.history.queryOptions({ input: { id } }));

  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <h2 id={headingId} className="text-xl font-bold">
        {t("order.history.title")}
      </h2>
      {history.isPending && <p>{t("common.loading")}</p>}
      {history.error && <p className="text-error">{errorMessage(history.error)}</p>}
      {history.isSuccess && history.data.length === 0 && <p>{t("order.history.empty")}</p>}
      <ol className="space-y-2">
        {history.data?.map((entry) => (
          <li key={entry.id} className="rounded-box bg-base-100 p-3 shadow-sm">
            <div className="font-semibold">
              <EntryTitle entry={entry} />
            </div>
            <div className="text-sm opacity-70">
              {format.dateTime(entry.at, { dateStyle: "short", timeStyle: "short" })}
              {entry.bySystem
                ? ` · ${t("order.history.by", { name: t("order.history.system") })}`
                : entry.actorName && ` · ${t("order.history.by", { name: entry.actorName })}`}
              {entry.stationName && ` · ${t("order.history.at", { station: entry.stationName })}`}
            </div>
            {entry.reason && <p className="mt-1 whitespace-pre-line">{reasonText(entry.reason)}</p>}
          </li>
        ))}
      </ol>
    </section>
  );
}

function EntryTitle({ entry }: { entry: OrderHistoryEntry }) {
  const t = useTranslations();
  switch (entry.type) {
    case "claim":
      return t("order.history.claim");
    case "release":
      return t("order.history.release");
    case "takeOver":
      return t("order.history.takeOver", { name: entry.previousHolderName ?? "—" });
    case "stage": {
      const to = entry.toStatus ? t(`status.${entry.toStatus}`) : "—";
      return entry.fromStatus
        ? t("order.history.stage", { from: t(`status.${entry.fromStatus}`), to })
        : t("order.history.imported", { to });
    }
  }
}
