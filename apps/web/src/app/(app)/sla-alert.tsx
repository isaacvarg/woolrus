"use client";

import { useQuery } from "@tanstack/react-query";
import type { SlaStage } from "@woolrus/contracts";
import { Clock } from "lucide-react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { Fragment } from "react";
import { orpc } from "@/lib/orpc";
import { queues } from "@/lib/queues";

/**
 * Orders past their stage's SLA, above the dashboard tiles (SPEC-reporting "Home dashboard").
 * Reads `orders.counts`, so it refreshes on the same order events as the tiles and the sidebar.
 */
export function SlaAlert() {
  const late = useQuery(orpc.orders.counts.queryOptions()).data?.late;
  return <SlaAlertStrip late={late} />;
}

const LIST_SLOT = "\u{E000}";

/** "3 in Packing and 1 in QA past SLA", each count a link to its queue; nothing while none is late. */
export function SlaAlertStrip({ late }: { late: Record<SlaStage, number> | undefined }) {
  const t = useTranslations("dashboard.slaAlert");
  const locale = useLocale();
  const stages = queues.flatMap((queue) =>
    queue.stage !== "ON_HOLD" && (late?.[queue.stage] ?? 0) > 0
      ? [{ ...queue, stage: queue.stage, count: late?.[queue.stage] ?? 0 }]
      : [],
  );
  if (stages.length === 0) return null;

  // Join the links as the locale joins a list ("a, b and c"): format placeholders, then swap
  // each one for its link.
  const parts = new Intl.ListFormat(locale, { type: "conjunction" }).formatToParts(
    stages.map((s) => s.stage),
  );
  let previous = "start";
  const list = parts.map((part) => {
    const stage = stages.find((s) => s.stage === part.value);
    if (part.type !== "element" || !stage) {
      return <Fragment key={`after-${previous}`}>{part.value}</Fragment>;
    }
    previous = stage.stage;
    return (
      <Link
        key={stage.stage}
        href={`/queue/${stage.slug}?late=1`}
        className="btn btn-sm min-h-11 border-warning-content/40 bg-warning-content/10 px-3 text-base text-warning-content hover:bg-warning-content/20"
      >
        {t(`stage.${stage.stage}`, { count: stage.count })}
      </Link>
    );
  });

  // Messages are plain ICU (no rich tags): place the links where the sentence puts `{list}`.
  const [before = "", after = ""] = t("summary", { list: LIST_SLOT }).split(LIST_SLOT);

  return (
    <div
      role="status"
      aria-label={t("label")}
      className="flex items-center gap-3 rounded-box bg-warning p-3 text-base text-warning-content"
      data-testid="sla-alert"
    >
      <Clock aria-hidden="true" className="size-6 shrink-0" />
      <p className="flex flex-wrap items-center gap-x-1 gap-y-2">
        {before}
        {list}
        {after}
      </p>
    </div>
  );
}
