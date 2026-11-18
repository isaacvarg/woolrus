"use client";

import { useQuery } from "@tanstack/react-query";
import {
  type ThroughputReport as Report,
  ReportRange,
  ThroughputPerson,
  type ThroughputPersonRef,
  ThroughputStage,
} from "@woolrus/contracts";
import { useSearchParams } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartFigure } from "@/components/charts/chart-figure";
import { seriesColor, useChartAnimation, useChartColors } from "@/components/charts/theme";
import { ExportCsvLink } from "@/components/export-csv-link";
import { SelectField } from "@/components/ui/fields";
import { useErrorMessage } from "@/lib/errors";
import { orpc } from "@/lib/orpc";
import { ReportBody, reportView } from "../report-view";
import { useReportRange } from "../use-report-range";

const ALL = "all";
const SYSTEM = "system";

/** The stage and person filters, kept in the URL next to the range so a link shares the view. */
function useFilters() {
  const params = useSearchParams();
  const stage = ThroughputStage.safeParse(params.get("stage")).data;
  const person = ThroughputPerson.safeParse(params.get("person")).data;
  const set = (key: "stage" | "person", value: string) => {
    const next = new URLSearchParams(params);
    if (value === ALL) next.delete(key);
    else next.set(key, value);
    const search = next.toString();
    window.history.pushState(null, "", `${window.location.pathname}${search ? `?${search}` : ""}`);
  };
  return { stage, person, set };
}

/** A day (YYYY-MM-DD) read back at UTC midnight, so no zone moves it. */
function useDay() {
  const format = useFormatter();
  return {
    short: (day: string) =>
      format.dateTime(new Date(`${day}T00:00:00Z`), {
        timeZone: "UTC",
        month: "short",
        day: "numeric",
      }),
    long: (day: string) =>
      format.dateTime(new Date(`${day}T00:00:00Z`), { timeZone: "UTC", dateStyle: "medium" }),
  };
}

function usePersonName() {
  const t = useTranslations("reports.throughput");
  return (person: ThroughputPersonRef) =>
    person.id === null ? t("system") : (person.name ?? t("unnamed"));
}

/**
 * Reports → Throughput (FR-REP-01, SPEC-reporting "Throughput"): units per day by stage, the
 * warehouse's orders imported and shipped, and each person's orders, units and active days.
 */
export function ThroughputReport() {
  const t = useTranslations("reports.throughput");
  const errorMessage = useErrorMessage();
  const personName = usePersonName();
  const { range } = useReportRange();
  const { stage, person, set } = useFilters();
  const input = { ...range, stage, person };
  const valid = ReportRange.safeParse(range).success;
  const query = useQuery({
    ...orpc.reports.throughput.queryOptions({ input }),
    enabled: valid,
    placeholderData: (previous) => previous,
  });
  const { data, loading, busy, error } = reportView(query, valid);

  const persons = data?.persons ?? [];
  const personOptions = [
    { id: ALL, label: t("all") },
    ...persons.map((p) => ({ id: p.id ?? SYSTEM, label: personName(p) })),
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-4">
        <div className="w-44">
          <SelectField
            label={t("stage")}
            selectedKey={stage ?? ALL}
            onSelectionChange={(key) => set("stage", String(key))}
            options={[
              { id: ALL, label: t("all") },
              ...ThroughputStage.options.map((s) => ({ id: s, label: t(`stages.${s}`) })),
            ]}
          />
        </div>
        <div className="w-56">
          <SelectField
            label={t("person")}
            selectedKey={person && personOptions.some((o) => o.id === person) ? person : ALL}
            onSelectionChange={(key) => set("person", String(key))}
            options={personOptions}
          />
        </div>
        {valid && (
          <div className="ms-auto">
            <ExportCsvLink
              path="/api/reports/throughput.csv"
              params={{ from: range.from, to: range.to, stage, person }}
            />
          </div>
        )}
      </div>

      {loading && <p>{t("loading")}</p>}
      {error && (
        <p role="alert" className="text-error">
          {errorMessage(error)}
        </p>
      )}
      {data && (
        <ReportBody busy={busy}>
          {data.rows.length === 0 ? (
            <p className="rounded-box bg-base-100 p-4 shadow-sm">{t("empty")}</p>
          ) : (
            <UnitsByDay data={data} stage={stage} />
          )}
          <Warehouse data={data} />
          {data.people.length > 0 && <ByPerson data={data} />}
        </ReportBody>
      )}
    </div>
  );
}

function UnitsByDay({ data, stage }: { data: Report; stage: ThroughputStage | undefined }) {
  const t = useTranslations("reports.throughput");
  const format = useFormatter();
  const colors = useChartColors();
  const animate = useChartAnimation();
  const day = useDay();
  const stages = ThroughputStage.options.filter((s) => !stage || s === stage);
  const byDay = data.days.map((d) => {
    const cells = data.rows.filter((r) => r.day === d.day);
    return {
      day: d.day,
      ...Object.fromEntries(
        stages.flatMap((s) => {
          const of = cells.filter((r) => r.stage === s);
          return [
            [s, of.reduce((n, r) => n + r.units, 0)],
            [`${s}:orders`, of.reduce((n, r) => n + r.orders, 0)],
          ];
        }),
      ),
    } as { day: string } & Record<string, number>;
  });
  const tick = { fill: colors.text, fontSize: 12 };

  return (
    <ChartFigure
      title={t("byDayTitle")}
      note={t("byDayNote")}
      height={280}
      chart={
        <ResponsiveContainer width="100%" height="100%">
          <BarChart accessibilityLayer={false} data={byDay} margin={{ top: 8, right: 16 }}>
            <CartesianGrid stroke={colors.grid} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="day" tick={tick} tickFormatter={day.short} minTickGap={16} />
            <YAxis tick={tick} allowDecimals={false} width={48} />
            <Tooltip
              cursor={{ fill: colors.grid, opacity: 0.4 }}
              contentStyle={{
                background: colors.surface,
                borderColor: colors.grid,
                color: colors.text,
              }}
              labelFormatter={(d) => day.long(String(d))}
              formatter={(value) => format.number(Number(value))}
            />
            <Legend wrapperStyle={{ color: colors.text }} />
            {stages.map((s) => (
              <Bar
                key={s}
                isAnimationActive={animate}
                dataKey={s}
                name={t(`stages.${s}`)}
                stackId="units"
                fill={seriesColor(colors, ThroughputStage.options.indexOf(s))}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      }
      table={
        <table className="table table-sm">
          <caption className="sr-only">{t("byDayTitle")}</caption>
          <thead>
            <tr>
              <th>{t("day")}</th>
              {stages.map((s) => (
                <th key={s} className="text-end">
                  {t(`stages.${s}`)}: {t("units")} / {t("orders")}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {byDay.map((row) => (
              <tr key={row.day}>
                <td>{day.long(row.day)}</td>
                {stages.map((s) => (
                  <td key={s} className="text-end">
                    {format.number(row[s] ?? 0)} / {format.number(row[`${s}:orders`] ?? 0)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      }
    />
  );
}

function Warehouse({ data }: { data: Report }) {
  const t = useTranslations("reports.throughput");
  const format = useFormatter();
  const colors = useChartColors();
  const animate = useChartAnimation();
  const day = useDay();
  const tick = { fill: colors.text, fontSize: 12 };
  const series = [
    { key: "imported", name: t("imported") },
    { key: "shipped", name: t("shipped") },
  ] as const;

  return (
    <ChartFigure
      title={t("warehouseTitle")}
      height={220}
      chart={
        <ResponsiveContainer width="100%" height="100%">
          <BarChart accessibilityLayer={false} data={data.days} margin={{ top: 8, right: 16 }}>
            <CartesianGrid stroke={colors.grid} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="day" tick={tick} tickFormatter={day.short} minTickGap={16} />
            <YAxis tick={tick} allowDecimals={false} width={48} />
            <Tooltip
              cursor={{ fill: colors.grid, opacity: 0.4 }}
              contentStyle={{
                background: colors.surface,
                borderColor: colors.grid,
                color: colors.text,
              }}
              labelFormatter={(d) => day.long(String(d))}
              formatter={(value) => format.number(Number(value))}
            />
            <Legend wrapperStyle={{ color: colors.text }} />
            {series.map((s, i) => (
              <Bar
                key={s.key}
                isAnimationActive={animate}
                dataKey={s.key}
                name={s.name}
                fill={seriesColor(colors, i + 4)}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      }
      table={
        <table className="table table-sm">
          <caption className="sr-only">{t("warehouseTitle")}</caption>
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
            {data.days.map((row) => (
              <tr key={row.day}>
                <td>{day.long(row.day)}</td>
                <td className="text-end">{format.number(row.imported)}</td>
                <td className="text-end">{format.number(row.shipped)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      }
    />
  );
}

function ByPerson({ data }: { data: Report }) {
  const t = useTranslations("reports.throughput");
  const format = useFormatter();
  const personName = usePersonName();
  return (
    <section className="space-y-2 rounded-box bg-base-100 p-4 shadow-sm">
      <h2 className="font-semibold">{t("byPersonTitle")}</h2>
      <div className="overflow-x-auto">
        <table className="table table-sm" data-testid="throughput-by-person">
          <thead>
            <tr>
              <th>{t("person")}</th>
              <th>{t("stage")}</th>
              <th className="text-end">{t("orders")}</th>
              <th className="text-end">{t("units")}</th>
              <th className="text-end">{t("activeDays")}</th>
            </tr>
          </thead>
          <tbody>
            {data.people.map((row) => (
              <tr key={`${row.stage}:${row.person.id ?? SYSTEM}`}>
                <td>{personName(row.person)}</td>
                <td>{t(`stages.${row.stage}`)}</td>
                <td className="text-end">{format.number(row.orders)}</td>
                <td className="text-end">{format.number(row.units)}</td>
                <td className="text-end">{format.number(row.activeDays)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
