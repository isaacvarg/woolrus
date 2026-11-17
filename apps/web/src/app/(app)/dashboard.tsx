"use client";

import { useQuery } from "@tanstack/react-query";
import type { DailyActivity } from "@woolrus/contracts";
import {
  Ban,
  CirclePause,
  ClipboardCheck,
  Inbox,
  type LucideIcon,
  Package,
  ShoppingBasket,
  TriangleAlert,
  Truck,
} from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { ToggleButton, ToggleButtonGroup } from "react-aria-components";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartFigure } from "@/components/charts/chart-figure";
import { seriesColor, useChartAnimation, useChartColors } from "@/components/charts/theme";
import { orpc } from "@/lib/orpc";
import { type Queue, queues } from "@/lib/queues";

/**
 * The home dashboard. Its counts share query keys with the sidebar, so order events refresh both
 * (see `lib/live.ts`).
 */
export function Dashboard() {
  return (
    <div className="space-y-6">
      <StatTiles />
      <ActivityChart />
      <QueueButtons />
    </div>
  );
}

const pending = "…";

function StatTiles() {
  const t = useTranslations("dashboard.tiles");
  const format = useFormatter();
  const counts = useQuery(orpc.orders.counts.queryOptions()).data;
  const issues = useQuery(orpc.issues.counts.queryOptions()).data;
  const n = (value: number | undefined) => (value === undefined ? pending : format.number(value));
  const open = counts && Object.values(counts).reduce((sum, count) => sum + count, 0);

  return (
    <dl className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
      <Tile
        label={t("open")}
        value={n(open)}
        hint={t("openHint")}
        className="col-span-2 md:col-span-3 xl:col-span-1"
        testId="tile-open"
      />
      <Tile
        label={t("picking")}
        value={n(counts && counts.PENDING + counts.PICKING)}
        hint={
          counts &&
          t("pickingHint", {
            pending: format.number(counts.PENDING),
            picking: format.number(counts.PICKING),
          })
        }
        testId="tile-picking"
      />
      <Tile label={t("packing")} value={n(counts?.PACKING)} testId="tile-packing" />
      <Tile label={t("qa")} value={n(counts?.QA)} testId="tile-qa" />
      <Tile
        label={t("issues")}
        value={n(issues?.open)}
        hint={
          issues && issues.openCritical > 0 ? (
            <span className="inline-flex items-center gap-1 font-semibold text-error">
              <TriangleAlert aria-hidden="true" className="size-4" />
              {t("issuesCritical", { count: issues.openCritical })}
            </span>
          ) : undefined
        }
        testId="tile-issues"
      />
    </dl>
  );
}

function Tile({
  label,
  value,
  hint,
  className = "",
  testId,
}: {
  label: string;
  value: string;
  hint?: React.ReactNode;
  className?: string;
  testId: string;
}) {
  return (
    <div className={`rounded-box bg-base-100 p-4 shadow-sm ${className}`} data-testid={testId}>
      <dt className="text-sm text-base-content/70">{label}</dt>
      <dd className="text-4xl font-semibold tabular-nums">{value}</dd>
      {hint && <dd className="mt-1 text-sm text-base-content/70">{hint}</dd>}
    </div>
  );
}

const ranges = [14, 30] as const;
type Range = (typeof ranges)[number];

/** The viewer's own zone, so "today" on the chart is their today. */
const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

function ActivityChart() {
  const t = useTranslations("dashboard.chart");
  const format = useFormatter();
  const colors = useChartColors();
  const animate = useChartAnimation();
  const [days, setDays] = useState<Range>(14);
  const [zone] = useState(timeZone);
  const activity = useQuery(
    orpc.orders.dailyActivity.queryOptions({ input: { days, timeZone: zone } }),
  );
  const data: DailyActivity = activity.data ?? [];

  // Days come as YYYY-MM-DD in the viewer's zone: read them back at UTC midnight so no zone moves
  // them a day.
  const short = (day: string) =>
    format.dateTime(new Date(`${day}T00:00:00Z`), {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
    });
  const long = (day: string) =>
    format.dateTime(new Date(`${day}T00:00:00Z`), { timeZone: "UTC", dateStyle: "medium" });
  const tick = { fill: colors.text, fontSize: 12 };
  const series = [
    { key: "received", name: t("received") },
    { key: "completed", name: t("completed") },
  ] as const;

  return (
    <div className="space-y-2">
      <ToggleButtonGroup
        aria-label={t("range")}
        selectionMode="single"
        disallowEmptySelection
        selectedKeys={[String(days)]}
        onSelectionChange={(keys) => {
          const next = Number([...keys][0]);
          if (next === 14 || next === 30) setDays(next);
        }}
        className="join"
      >
        {ranges.map((range) => (
          <ToggleButton
            key={range}
            id={String(range)}
            className={({ isSelected }) =>
              `btn join-item btn-sm ${isSelected ? "btn-primary" : "btn-outline"}`
            }
          >
            {t("lastDays", { days: range })}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
      <ChartFigure
        title={t("title", { days })}
        height={260}
        chart={
          <ResponsiveContainer width="100%" height="100%">
            <LineChart accessibilityLayer={false} data={data} margin={{ top: 8, right: 16 }}>
              <CartesianGrid stroke={colors.grid} strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="day" tick={tick} tickFormatter={short} minTickGap={16} />
              <YAxis tick={tick} allowDecimals={false} width={40} />
              <Tooltip
                cursor={{ stroke: colors.grid, strokeWidth: 1 }}
                contentStyle={{
                  background: colors.surface,
                  borderColor: colors.grid,
                  color: colors.text,
                }}
                labelFormatter={(day) => long(String(day))}
                formatter={(value) => format.number(Number(value))}
              />
              <Legend wrapperStyle={{ color: colors.text }} />
              {series.map((s, i) => (
                <Line
                  key={s.key}
                  isAnimationActive={animate}
                  type="monotone"
                  dataKey={s.key}
                  name={s.name}
                  stroke={seriesColor(colors, i)}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4, stroke: colors.surface, strokeWidth: 2 }}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        }
        table={
          <table className="table table-sm">
            <caption className="sr-only">{t("title", { days })}</caption>
            <thead>
              <tr>
                <th>{t("day")}</th>
                {series.map((s) => (
                  <th key={s.key} className="text-end">
                    {s.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((row) => (
                <tr key={row.day}>
                  <td>{long(row.day)}</td>
                  <td className="text-end">{format.number(row.received)}</td>
                  <td className="text-end">{format.number(row.completed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        }
      />
    </div>
  );
}

const queueIcons: Record<Queue["stage"], LucideIcon> = {
  PENDING: Inbox,
  PICKING: ShoppingBasket,
  PACKING: Package,
  QA: ClipboardCheck,
  READY: Truck,
  ON_HOLD: CirclePause,
};

/** Big touch targets for the tablet: one per queue, then Voids and Issues, each with its count. */
function QueueButtons() {
  const t = useTranslations();
  const format = useFormatter();
  const counts = useQuery(orpc.orders.counts.queryOptions()).data;
  const voids = useQuery(orpc.voids.counts.queryOptions()).data;
  const issues = useQuery(orpc.issues.counts.queryOptions()).data;
  const n = (value: number | undefined) => (value === undefined ? pending : format.number(value));

  const buttons = [
    ...queues.map((queue) => ({
      href: `/queue/${queue.slug}` as const,
      label: t(queue.label),
      icon: queueIcons[queue.stage],
      count: n(counts?.[queue.stage]),
    })),
    {
      href: "/voids" as const,
      label: t("nav.voids"),
      icon: Ban,
      count: n(voids?.unresolvedOrders),
    },
    {
      href: "/issues" as const,
      label: t("nav.issues"),
      icon: TriangleAlert,
      count: n(issues?.open),
    },
  ];

  return (
    <section aria-label={t("nav.queues")}>
      <ul className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
        {buttons.map(({ href, label, icon: Icon, count }) => (
          <li key={href}>
            <Link
              href={href}
              className="btn btn-outline h-auto min-h-28 w-full flex-col gap-2 rounded-box bg-base-100 py-4 text-lg"
            >
              <Icon aria-hidden="true" className="size-8" />
              <span>{label}</span>
              <span className="badge badge-lg tabular-nums">{count}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
