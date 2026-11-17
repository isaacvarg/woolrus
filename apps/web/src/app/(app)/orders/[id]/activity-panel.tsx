"use client";

import { useQuery } from "@tanstack/react-query";
import {
  type ActivityCategory,
  type ActivityEntry,
  type ActivityItem,
  ActivityCategory as Categories,
} from "@woolrus/contracts";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useId, useState } from "react";
import { ToggleButton, ToggleButtonGroup } from "react-aria-components";
import { Button } from "@/components/ui/fields";
import { useErrorMessage } from "@/lib/errors";
import { orpc } from "@/lib/orpc";
import { useReasonText } from "@/lib/reasons";
import { ActivitySummary } from "./activity-summary";
import { useActivityWording } from "./activity-wording";

type Filter = ActivityCategory | "all";

/**
 * Everything recorded for the order, newest first (SPEC-order-activity "UI"): the order page's
 * History tab and the pack and QA drawers. Refetches on the order's `order_changed` event
 * (`lib/live.ts`).
 */
export function ActivityPanel({ id }: { id: string }) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const headingId = useId();
  const [filter, setFilter] = useState<Filter>("all");
  const activity = useQuery(orpc.orders.activity.queryOptions({ input: { id } }));

  const entries = activity.data?.entries ?? [];
  const counts = new Map<ActivityCategory, number>();
  for (const entry of entries) counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
  const shown = filter === "all" ? entries : entries.filter((e) => e.category === filter);

  return (
    <section aria-labelledby={headingId} className="space-y-3" data-testid="activity-panel">
      <h2 id={headingId} className="text-xl font-bold">
        {t("activity.title")}
      </h2>
      {activity.isPending && <p>{t("common.loading")}</p>}
      {activity.error && <p className="text-error">{errorMessage(activity.error)}</p>}
      {activity.data && (
        <ActivitySummary summary={activity.data.summary} people={activity.data.people} />
      )}
      {activity.isSuccess && entries.length === 0 && <p>{t("activity.empty")}</p>}
      {entries.length > 0 && (
        <ToggleButtonGroup
          aria-label={t("activity.filters")}
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[filter]}
          onSelectionChange={(keys) => setFilter(([...keys][0] as Filter | undefined) ?? "all")}
          className="flex flex-wrap gap-2"
        >
          <Chip id="all" label={t("activity.all")} count={entries.length} />
          {Categories.options
            .filter((category) => counts.has(category))
            .map((category) => (
              <Chip
                key={category}
                id={category}
                label={t(`activity.category.${category}`)}
                count={counts.get(category) ?? 0}
              />
            ))}
        </ToggleButtonGroup>
      )}
      <ol className="space-y-2">
        {shown.map((entry) => (
          <Entry key={entry.id} entry={entry} orderId={id} />
        ))}
      </ol>
      {activity.data?.truncated && (
        <p className="text-sm opacity-70">{t("activity.truncated", { count: entries.length })}</p>
      )}
    </section>
  );
}

function Chip({ id, label, count }: { id: Filter; label: string; count: number }) {
  return (
    <ToggleButton
      id={id}
      className={({ isSelected }) =>
        `btn btn-sm h-auto min-h-11 ${isSelected ? "btn-primary" : "btn-outline"}`
      }
    >
      {label}
      <span className="badge badge-sm">{count}</span>
    </ToggleButton>
  );
}

function Entry({ entry, orderId }: { entry: ActivityEntry; orderId: string }) {
  const t = useTranslations();
  const format = useFormatter();
  const [open, setOpen] = useState(false);
  const membersId = useId();
  const time = (at: Date) => format.dateTime(at, { timeStyle: "short" });
  const problem = entry.category === "problems";

  return (
    <li
      className={`rounded-box bg-base-100 p-3 shadow-sm ${problem ? "border-error border-l-4" : ""}`}
      data-category={entry.category}
    >
      <ItemBody item={entry} problem={problem} orderId={orderId} />
      {entry.count > 1 && (
        <>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
            <span className="opacity-70">
              {t("activity.grouped", {
                count: entry.count,
                from: time(entry.firstAt),
                to: time(entry.at),
              })}
            </span>
            <Button
              className="btn-ghost btn-sm h-auto min-h-11"
              aria-expanded={open}
              aria-controls={membersId}
              onPress={() => setOpen((v) => !v)}
            >
              {open ? t("activity.hideMembers") : t("activity.showMembers")}
            </Button>
          </div>
          {open && (
            <ol id={membersId} className="border-base-300 mt-2 space-y-2 border-l-2 ps-3">
              {entry.members.map((member) => (
                <li key={member.id}>
                  <ItemBody item={member} problem={problem} orderId={orderId} />
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </li>
  );
}

function ItemBody({
  item,
  problem,
  orderId,
}: {
  item: ActivityItem;
  problem: boolean;
  orderId: string;
}) {
  const t = useTranslations();
  const format = useFormatter();
  const reasonText = useReasonText();
  const wording = useActivityWording();
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const who = wording.who(item);
  const reason = typeof item.params.reason === "string" ? item.params.reason : null;

  return (
    <div>
      <div className={`font-semibold ${problem ? "text-error" : ""}`}>
        {wording.message(item)}
        {item.target && (
          <span className="badge badge-ghost ms-2 align-middle">{wording.target(item.target)}</span>
        )}
      </div>
      <div className="text-sm opacity-70">
        {[
          who,
          item.station && t("activity.at", { station: item.station }),
          format.dateTime(item.at, { dateStyle: "short", timeStyle: "short" }),
        ]
          .filter(Boolean)
          .join(" · ")}
      </div>
      {reason && <p className="mt-1 whitespace-pre-line">{reasonText(reason)}</p>}
      {item.category === "notes" && (
        // The feed never carries a note's text; the Notes tab shows it under the note rules.
        <Link
          href={`/orders/${orderId}?tab=notes`}
          className="link inline-flex min-h-11 items-center"
        >
          {t("activity.openNotes")}
        </Link>
      )}
      {item.details && (
        <>
          <Button
            className="btn-ghost btn-sm h-auto min-h-11 px-0"
            aria-expanded={open}
            aria-controls={detailsId}
            onPress={() => setOpen((v) => !v)}
          >
            {open ? t("activity.hideDetails") : t("activity.showDetails")}
          </Button>
          {open && <Changes id={detailsId} details={item.details} />}
        </>
      )}
    </div>
  );
}

const show = (value: unknown, none: string) =>
  value === undefined || value === null
    ? none
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);

const fields = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Before → after, one line per field that either side has. */
function Changes({ id, details }: { id: string; details: { before: unknown; after: unknown } }) {
  const t = useTranslations();
  const before = fields(details.before);
  const after = fields(details.after);
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const none = t("activity.noValue");
  return (
    <dl id={id} className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
      {keys.map((key) => (
        <div key={key} className="contents">
          <dt className="font-mono opacity-70">{key}</dt>
          <dd className="break-words">
            {before[key] === undefined
              ? show(after[key], none)
              : `${show(before[key], none)} → ${show(after[key], none)}`}
          </dd>
        </div>
      ))}
    </dl>
  );
}
