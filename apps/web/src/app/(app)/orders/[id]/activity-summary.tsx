"use client";

import type {
  OrderActivitySummary,
  StageInterval,
  StagePeople,
  StageSummary,
} from "@woolrus/contracts";
import { useFormatter, useTranslations } from "next-intl";
import { useId } from "react";

const MINUTE = 60_000;

/** "45 min", "2 h 5 min", "3 d 4 h": whole minutes, the two largest units. */
export function useDuration() {
  const t = useTranslations("activity.summary.duration");
  return (ms: number) => {
    const minutes = Math.round(ms / MINUTE);
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const rest = minutes % 60;
    if (days > 0) return t("days", { days, hours });
    if (hours > 0) return t("hours", { hours, minutes: rest });
    return t("minutes", { minutes: rest });
  };
}

/**
 * The top of the History tab (SPEC-order-activity "Stage summary", "UI"): status time per stage,
 * a waiting/working bar for each work interval, and who worked each work stage.
 */
export function ActivitySummary({
  summary,
  people,
}: {
  summary: OrderActivitySummary;
  people: readonly StagePeople[];
}) {
  const t = useTranslations();
  const duration = useDuration();
  const headingId = useId();
  const reached = summary.stages.filter((s) => s.intervals.length > 0);
  if (reached.length === 0) return null;

  return (
    <section
      aria-labelledby={headingId}
      className="rounded-box bg-base-100 space-y-3 p-3 shadow-sm"
      data-testid="activity-summary"
    >
      <h3 id={headingId} className="text-lg font-bold">
        {t("activity.summary.title")}
      </h3>
      <ul className="space-y-3">
        {reached.map((stage) => (
          <StageRow
            key={stage.stage}
            stage={stage}
            people={people.find((p) => p.stage === stage.stage)?.people ?? []}
          />
        ))}
      </ul>
      {summary.onHoldMs > 0 && (
        <p className="text-sm opacity-70">
          {t("activity.summary.onHold", { time: duration(summary.onHoldMs) })}
        </p>
      )}
      <p className="text-sm opacity-70">{t("activity.summary.workingNote")}</p>
    </section>
  );
}

function StageRow({ stage, people }: { stage: StageSummary; people: StagePeople["people"] }) {
  const t = useTranslations();
  const format = useFormatter();
  const duration = useDuration();
  const time = (at: Date) => format.dateTime(at, { timeStyle: "short" });
  const several = stage.intervals.length > 1;

  return (
    <li data-stage={stage.stage}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-semibold">{t(`status.${stage.stage}`)}</span>
        <span>
          {duration(stage.statusMs)}
          {stage.intervals.some((i) => i.running) && (
            <span className="badge badge-sm badge-info ms-2">{t("activity.summary.now")}</span>
          )}
        </span>
      </div>
      {stage.intervals.map((interval, index) =>
        interval.waitingMs === null ? null : (
          <WorkInterval
            key={interval.start.toISOString()}
            interval={interval}
            round={several ? index + 1 : null}
          />
        ),
      )}
      {people.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-sm">
          {people.map((person) => (
            <li key={person.id}>
              {t("activity.summary.person", {
                name: person.name,
                count: person.count,
                from: time(person.firstAt),
                to: time(person.lastAt),
                span: duration(person.spanMs),
              })}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** One stay in a work stage: its waiting/working bar, and its batch when picked in one. */
function WorkInterval({ interval, round }: { interval: StageInterval; round: number | null }) {
  const t = useTranslations("activity.summary");
  const duration = useDuration();
  const waiting = interval.waitingMs ?? 0;
  const working = interval.workingMs ?? 0;
  const total = waiting + working;
  const waitingShare = total > 0 ? (waiting / total) * 100 : 100;
  const label = t("bar", { waiting: duration(waiting), working: duration(working) });

  return (
    <div className="mt-1 space-y-1">
      {round !== null && (
        <div className="text-sm opacity-70">
          {t("round", { round, time: duration(interval.statusMs) })}
        </div>
      )}
      <div
        role="img"
        aria-label={label}
        className="bg-base-300 flex h-3 w-full overflow-hidden rounded-full"
      >
        <div className="bg-warning h-full" style={{ width: `${waitingShare}%` }} />
        <div className="bg-success h-full" style={{ width: `${100 - waitingShare}%` }} />
      </div>
      <div className="flex flex-wrap justify-between gap-2 text-sm">
        <span>{t("waiting", { time: duration(waiting) })}</span>
        <span>{t("working", { time: duration(working) })}</span>
      </div>
      {interval.batch && (
        <div className="text-sm">
          {t("batch", {
            number: interval.batch.number ?? "?",
            orders: interval.batch.orders ?? 0,
          })}
        </div>
      )}
    </div>
  );
}
