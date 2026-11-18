"use client";

import { useQuery } from "@tanstack/react-query";
import {
  type CycleTimeStage,
  type DurationStat,
  type CycleTimeReport as Report,
  ReportRange,
} from "@woolrus/contracts";
import type { Route } from "next";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import {
  Bar,
  BarChart,
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
import {
  type ChartColors,
  seriesColor,
  useChartAnimation,
  useChartColors,
} from "@/components/charts/theme";
import { ExportCsvLink } from "@/components/export-csv-link";
import { useErrorMessage } from "@/lib/errors";
import { orpc } from "@/lib/orpc";
import { useDuration } from "../../orders/[id]/activity-summary";
import { useReportRange } from "../use-report-range";

const MINUTE = 60_000;

/**
 * Reports → Cycle time (SPEC-reporting "Cycle time", FR-REP-02): how long the orders shipped in
 * the range took, import to shipped and per stage, the median per shipping day, and the slowest
 * orders.
 */
export function CycleTimeReport() {
  const t = useTranslations("reports.cycleTime");
  const errorMessage = useErrorMessage();
  const { range } = useReportRange();
  const valid = ReportRange.safeParse(range).success;
  const query = useQuery({
    ...orpc.reports.cycleTime.queryOptions({ input: range }),
    enabled: valid,
    placeholderData: (previous) => previous,
  });
  const data = query.data;

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <ExportCsvLink
          path="/api/reports/cycle-time.csv"
          params={{ from: range.from, to: range.to }}
        />
      </div>
      {query.isPending && valid && <p>{t("loading")}</p>}
      {query.error && (
        <p role="alert" className="text-error">
          {errorMessage(query.error)}
        </p>
      )}
      {data &&
        (data.total.count === 0 ? (
          <p className="rounded-box bg-base-100 p-4 shadow-sm">{t("empty")}</p>
        ) : (
          <Figures data={data} />
        ))}
    </div>
  );
}

function Figures({ data }: { data: Report }) {
  const colors = useChartColors();
  return (
    <>
      <Summary data={data} />
      <StageChart stages={data.stages} colors={colors} />
      <DayChart data={data} colors={colors} />
      <Slowest data={data} />
    </>
  );
}

/** A figure in minutes, or a dash when there is none. */
function useTime() {
  const duration = useDuration();
  return (ms: number | null) => (ms === null ? "—" : duration(ms));
}

function Summary({ data }: { data: Report }) {
  const t = useTranslations("reports.cycleTime");
  const format = useFormatter();
  const time = useTime();
  const { total, onHold } = data;
  return (
    <section
      aria-label={t("summary")}
      className="stats stats-vertical lg:stats-horizontal w-full bg-base-100 shadow-sm"
    >
      <Tile title={t("tiles.orders")} value={format.number(total.count)} />
      <Tile
        title={t("tiles.median")}
        value={time(total.medianMs)}
        desc={t("tiles.importToShipped")}
      />
      <Tile title={t("tiles.p90")} value={time(total.p90Ms)} desc={t("tiles.importToShipped")} />
      <Tile title={t("tiles.mean")} value={time(total.meanMs)} desc={t("tiles.importToShipped")} />
      <Tile
        title={t("tiles.onHold")}
        value={time(onHold.meanMs)}
        desc={t("tiles.onHoldDesc", { median: time(onHold.medianMs) })}
      />
    </section>
  );
}

function Tile({ title, value, desc }: { title: string; value: string; desc?: string }) {
  return (
    <div className="stat">
      <div className="stat-title">{title}</div>
      <div className="stat-value text-2xl">{value}</div>
      {desc && <div className="stat-desc">{desc}</div>}
    </div>
  );
}

function axes(colors: ChartColors, minutes: (value: number) => string) {
  const tick = { fill: colors.text, fontSize: 12 };
  return {
    grid: <CartesianGrid stroke={colors.grid} strokeDasharray="3 3" vertical={false} />,
    tooltip: (
      <Tooltip
        contentStyle={{ background: colors.surface, borderColor: colors.grid, color: colors.text }}
        formatter={(value) => minutes(Number(value) * MINUTE)}
      />
    ),
    tick,
  };
}

/**
 * Mean time per stage, split into waiting, working and idle for the work stages. Means, because
 * they add up: the parts of a median don't make the median.
 */
function StageChart({ stages, colors }: { stages: CycleTimeStage[]; colors: ChartColors }) {
  const t = useTranslations();
  const animate = useChartAnimation();
  const time = useTime();
  const format = useFormatter();
  const parts = ["inQueue", "waiting", "working", "idle"] as const;
  const toMin = (ms: number | null | undefined) => (ms ?? 0) / MINUTE;
  const rows = stages.map((s) => ({
    name: t(`status.${s.stage}`),
    inQueue: s.waiting ? 0 : toMin(s.status.meanMs),
    waiting: toMin(s.waiting?.meanMs),
    working: toMin(s.working?.meanMs),
    idle: toMin(s.idle?.meanMs),
  }));
  const { grid, tooltip, tick } = axes(colors, (ms) => time(ms));
  const figure = (stat: DurationStat | null) =>
    stat
      ? [stat.medianMs, stat.p90Ms, stat.meanMs].map((ms) => time(ms)).join(" · ")
      : t("reports.cycleTime.notWork");
  const title = t("reports.cycleTime.stageChart");

  return (
    <ChartFigure
      title={title}
      note={t("reports.cycleTime.stageNote")}
      height={280}
      chart={
        <ResponsiveContainer width="100%" height="100%">
          <BarChart accessibilityLayer={false} data={rows} margin={{ top: 8, right: 16 }}>
            {grid}
            <XAxis dataKey="name" tick={tick} />
            <YAxis tick={tick} width={56} tickFormatter={(v) => time(Number(v) * MINUTE)} />
            {tooltip}
            <Legend wrapperStyle={{ color: colors.text }} />
            {parts.map((part, i) => (
              <Bar
                key={part}
                isAnimationActive={animate}
                stackId="stage"
                dataKey={part}
                name={t(`reports.cycleTime.parts.${part}`)}
                fill={seriesColor(colors, i)}
                // A white edge between segments, so the split reads without the colours.
                stroke={colors.surface}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      }
      table={
        <table className="table table-sm">
          <caption className="sr-only">{title}</caption>
          <thead>
            <tr>
              <th>{t("reports.cycleTime.columns.stage")}</th>
              <th className="text-end">{t("reports.cycleTime.columns.orders")}</th>
              <th>{t("reports.cycleTime.columns.status")}</th>
              <th>{t("reports.cycleTime.columns.waiting")}</th>
              <th>{t("reports.cycleTime.columns.working")}</th>
              <th>{t("reports.cycleTime.columns.idle")}</th>
            </tr>
          </thead>
          <tbody>
            {stages.map((s) => (
              <tr key={s.stage}>
                <th scope="row">{t(`status.${s.stage}`)}</th>
                <td className="text-end">{format.number(s.status.count)}</td>
                <td>{figure(s.status)}</td>
                <td>{figure(s.waiting)}</td>
                <td>{figure(s.working)}</td>
                <td>{figure(s.idle)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      }
    />
  );
}

/** The median import → shipped per shipping day, so a slow week stands out. */
function DayChart({ data, colors }: { data: Report; colors: ChartColors }) {
  const t = useTranslations("reports.cycleTime");
  const animate = useChartAnimation();
  const format = useFormatter();
  const time = useTime();
  const rows = data.byDay.map((d) => ({
    ...d,
    median: d.medianMs === null ? null : d.medianMs / MINUTE,
  }));
  const short = (day: string) =>
    format.dateTime(new Date(`${day}T00:00:00Z`), {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
    });
  const long = (day: string) =>
    format.dateTime(new Date(`${day}T00:00:00Z`), { timeZone: "UTC", dateStyle: "medium" });
  const { grid, tooltip, tick } = axes(colors, (ms) => time(ms));
  const title = t("dayChart");

  return (
    <ChartFigure
      title={title}
      height={260}
      chart={
        <ResponsiveContainer width="100%" height="100%">
          <LineChart accessibilityLayer={false} data={rows} margin={{ top: 8, right: 16 }}>
            {grid}
            <XAxis dataKey="day" tick={tick} tickFormatter={short} minTickGap={16} />
            <YAxis tick={tick} width={56} tickFormatter={(v) => time(Number(v) * MINUTE)} />
            {tooltip}
            <Line
              isAnimationActive={animate}
              type="monotone"
              dataKey="median"
              name={t("columns.median")}
              stroke={seriesColor(colors, 0)}
              strokeWidth={2}
              dot={{ r: 3 }}
              connectNulls
            />
          </LineChart>
        </ResponsiveContainer>
      }
      table={
        <table className="table table-sm">
          <caption className="sr-only">{title}</caption>
          <thead>
            <tr>
              <th>{t("columns.day")}</th>
              <th className="text-end">{t("columns.orders")}</th>
              <th className="text-end">{t("columns.median")}</th>
            </tr>
          </thead>
          <tbody>
            {data.byDay.map((d) => (
              <tr key={d.day}>
                <td>{long(d.day)}</td>
                <td className="text-end">{format.number(d.orders)}</td>
                <td className="text-end">{time(d.medianMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      }
    />
  );
}

/** The slowest orders, each linking to its History tab. */
function Slowest({ data }: { data: Report }) {
  const t = useTranslations("reports.cycleTime");
  const format = useFormatter();
  const time = useTime();
  return (
    <section className="space-y-2 rounded-box bg-base-100 p-4 shadow-sm">
      <h2 className="font-semibold">{t("slowest", { count: data.slowest.length })}</h2>
      <div className="overflow-x-auto">
        <table className="table table-sm">
          <thead>
            <tr>
              <th>{t("columns.order")}</th>
              <th>{t("columns.shipped")}</th>
              <th className="text-end">{t("columns.total")}</th>
              <th className="text-end">{t("columns.onHold")}</th>
            </tr>
          </thead>
          <tbody>
            {data.slowest.map((o) => (
              <tr key={o.id}>
                <td>
                  <Link className="link" href={`/orders/${o.id}?tab=history` as Route}>
                    {t("orderLink", { number: o.number })}
                  </Link>
                </td>
                <td>{format.dateTime(o.shippedAt, { dateStyle: "medium", timeStyle: "short" })}</td>
                <td className="text-end">{time(o.totalMs)}</td>
                <td className="text-end">{time(o.onHoldMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
