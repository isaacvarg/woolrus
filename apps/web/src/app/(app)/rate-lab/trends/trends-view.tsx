"use client";

import { useQuery } from "@tanstack/react-query";
import type {
  LabTrendCell,
  LabTrendGrid,
  LabTrendGridInput,
  LabTrendSeries,
} from "@woolrus/contracts";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
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
import { money } from "@/app/(app)/qa/[orderId]/money";
import { ChartFigure } from "@/components/charts/chart-figure";
import { seriesColor, useChartColors } from "@/components/charts/theme";
import { Button, Checkbox, TextField } from "@/components/ui/fields";
import { useErrorMessage } from "@/lib/errors";
import { orpc } from "@/lib/orpc";

/** A move this large either way gets the strong colour, as run insights flag it (PRICE_MOVE_PCT). */
const BIG_MOVE = 0.1;

type Filters = {
  addressGroupIds: string[];
  parcelGroupIds: string[];
  carrierIds: string[];
  from: string;
  to: string;
  includeFake: boolean;
};

type ListKey = "addressGroupIds" | "parcelGroupIds" | "carrierIds";

const toInput = (f: Filters): LabTrendGridInput => ({
  ...f,
  from: f.from || undefined,
  to: f.to || undefined,
});

type Picked = { addressId: string; parcelId: string };

/** The change bucket's background; the % is always in text too, so colour is never alone. */
function tone(change: number | null): string {
  if (change === null || change === 0) return "bg-base-200";
  if (change <= -BIG_MOVE) return "bg-success/50";
  if (change < 0) return "bg-success/20";
  if (change >= BIG_MOVE) return "bg-error/50";
  return "bg-error/20";
}

/** Rate Lab → Trends (SPEC-rate-lab): the price heatmap, and a chart for the picked cell. */
export function TrendsView() {
  const t = useTranslations("rateLab.trends");
  const errorMessage = useErrorMessage();
  const [filters, setFilters] = useState<Filters>({
    addressGroupIds: [],
    parcelGroupIds: [],
    carrierIds: [],
    from: "",
    to: "",
    includeFake: false,
  });
  const [picked, setPicked] = useState<Picked | null>(null);
  const set = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    setFilters((current) => ({ ...current, [key]: value }));
  const toggle = (key: ListKey, id: string, on: boolean) =>
    setFilters((current) => ({
      ...current,
      [key]: on ? [...current[key], id] : current[key].filter((x) => x !== id),
    }));

  const active = { includeArchived: false } as const;
  const addressGroups = useQuery(
    orpc.rateLab.groups.queryOptions({ input: { kind: "ADDRESS", ...active } }),
  );
  const parcelGroups = useQuery(
    orpc.rateLab.groups.queryOptions({ input: { kind: "PARCEL", ...active } }),
  );
  const grid = useQuery({
    ...orpc.rateLab.trendGrid.queryOptions({ input: toInput(filters) }),
    placeholderData: (previous) => previous,
  });

  const picker = (key: ListKey, legend: string, options: { id: string; name: string }[]) => (
    <fieldset>
      <legend className="fieldset-legend">{legend}</legend>
      {options.length === 0 && <p className="text-sm opacity-70">{t("none")}</p>}
      <div className="flex max-h-32 flex-wrap gap-x-4 overflow-y-auto">
        {options.map((option) => (
          <Checkbox
            key={option.id}
            isSelected={filters[key].includes(option.id)}
            onChange={(on) => toggle(key, option.id, on)}
          >
            {option.name}
          </Checkbox>
        ))}
      </div>
    </fieldset>
  );

  const data = grid.data;
  return (
    <div className="space-y-6">
      <div className="space-y-2 rounded-box bg-base-100 p-4 shadow-sm">
        <div className="grid gap-4 lg:grid-cols-3">
          {picker("addressGroupIds", t("addressGroups"), addressGroups.data ?? [])}
          {picker("parcelGroupIds", t("parcelGroups"), parcelGroups.data ?? [])}
          {picker("carrierIds", t("carriers"), data?.carriers ?? [])}
        </div>
        <div className="flex flex-wrap items-end gap-4">
          <div className="w-40">
            <TextField
              label={t("from")}
              type="date"
              value={filters.from}
              onChange={(v) => set("from", v)}
            />
          </div>
          <div className="w-40">
            <TextField
              label={t("to")}
              type="date"
              value={filters.to}
              onChange={(v) => set("to", v)}
            />
          </div>
          <Checkbox isSelected={filters.includeFake} onChange={(v) => set("includeFake", v)}>
            {t("includeFake")}
          </Checkbox>
        </div>
      </div>

      {grid.isPending && <p>{t("loading")}</p>}
      {grid.error && (
        <p role="alert" className="text-error">
          {errorMessage(grid.error)}
        </p>
      )}
      {data &&
        (data.cells.length === 0 ? (
          <p className="rounded-box bg-base-100 p-4 shadow-sm">{t("empty")}</p>
        ) : (
          <Heatmap grid={data} picked={picked} onPick={setPicked} />
        ))}
      {data && picked && (
        <SeriesChart
          key={`${picked.addressId}|${picked.parcelId}`}
          picked={picked}
          filters={filters}
          onClose={() => setPicked(null)}
        />
      )}
    </div>
  );
}

/**
 * Addresses down the side, parcels across the top. A real table, so screen readers get the
 * headers with each cell; each cell's price and % are text, and its colour only repeats the %.
 */
function Heatmap({
  grid,
  picked,
  onPick,
}: {
  grid: LabTrendGrid;
  picked: Picked | null;
  onPick: (picked: Picked) => void;
}) {
  const t = useTranslations("rateLab.trends");
  const format = useFormatter();
  const cells = new Map(grid.cells.map((c) => [`${c.addressId}|${c.parcelId}`, c]));
  const percent = (change: number) =>
    format.number(change, {
      style: "percent",
      maximumFractionDigits: 1,
      signDisplay: "exceptZero",
    });

  const content = (cell: LabTrendCell) => {
    if (!cell.latest) return <span className="opacity-60">{t("noData")}</span>;
    const isPicked = picked?.addressId === cell.addressId && picked.parcelId === cell.parcelId;
    return (
      <Button
        className={`btn-ghost h-auto min-h-0 w-full flex-col gap-0 py-1 ${isPicked ? "ring-2 ring-primary" : ""}`}
        aria-pressed={isPicked}
        onPress={() => onPick({ addressId: cell.addressId, parcelId: cell.parcelId })}
      >
        <span className="font-semibold">{money(format, cell.latest.amountCents)}</span>
        <span className="text-xs">
          {cell.change === null ? t("first") : percent(cell.change)}
          <span className="sr-only">
            {" "}
            {cell.change !== null && `${t("sincePrevious")}. `}
            {t("cheapestBy", {
              carrier: cell.latest.carrierName,
              service: cell.latest.serviceName,
            })}
          </span>
        </span>
      </Button>
    );
  };

  return (
    <section className="space-y-2 rounded-box bg-base-100 p-4 shadow-sm">
      <h2 id="lab-trends-heatmap" className="font-semibold">
        {t("heatmap")}
      </h2>
      <p className="text-sm opacity-70">{t("heatmapHint")}</p>
      <div className="overflow-x-auto">
        <table aria-labelledby="lab-trends-heatmap" className="table table-sm">
          <thead>
            <tr>
              <th scope="col">{t("address")}</th>
              {grid.parcels.map((p) => (
                <th key={p.id} scope="col" className="text-center">
                  {p.title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.addresses.map((a) => (
              <tr key={a.id}>
                <th scope="row">{a.title}</th>
                {grid.parcels.map((p) => {
                  const cell = cells.get(`${a.id}|${p.id}`);
                  return (
                    <td
                      key={p.id}
                      className={`border border-base-100 p-1 text-center ${tone(cell?.change ?? null)}`}
                    >
                      {cell && content(cell)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul aria-label={t("scale")} className="flex flex-wrap gap-3 text-xs">
        {(
          [
            ["bg-success/50", "bigDrop"],
            ["bg-success/20", "drop"],
            ["bg-base-200", "same"],
            ["bg-error/20", "rise"],
            ["bg-error/50", "bigRise"],
          ] as const
        ).map(([bg, key]) => (
          <li key={key} className="flex items-center gap-1">
            <span aria-hidden="true" className={`inline-block size-3 rounded-sm ${bg}`} />
            {t(`scaleSteps.${key}`)}
          </li>
        ))}
      </ul>
    </section>
  );
}

function SeriesChart({
  picked,
  filters,
  onClose,
}: {
  picked: Picked;
  filters: Filters;
  onClose: () => void;
}) {
  const t = useTranslations("rateLab.trends");
  const errorMessage = useErrorMessage();
  const series = useQuery(
    orpc.rateLab.trendSeries.queryOptions({
      input: {
        ...picked,
        carrierIds: filters.carrierIds,
        from: filters.from || undefined,
        to: filters.to || undefined,
        includeFake: filters.includeFake,
      },
    }),
  );
  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <Button className="btn-ghost btn-sm" onPress={onClose}>
          {t("close")}
        </Button>
      </div>
      {series.isPending && <p>{t("loading")}</p>}
      {series.error && (
        <p role="alert" className="text-error">
          {errorMessage(series.error)}
        </p>
      )}
      {series.data && <SeriesFigure series={series.data} />}
    </div>
  );
}

function SeriesFigure({ series }: { series: LabTrendSeries }) {
  const t = useTranslations("rateLab.trends");
  const format = useFormatter();
  const colors = useChartColors();
  const cents = (value: number) => money(format, value);
  const when = (at: Date) => format.dateTime(at, { dateStyle: "medium" });
  const name = (line: LabTrendSeries["lines"][number]) => `${line.carrierName} ${line.serviceName}`;
  const titled = (item: { title: string; archived: boolean }) =>
    item.archived ? t("archived", { title: item.title }) : item.title;
  const amounts = new Map(
    series.lines.flatMap((line) =>
      line.points.map((p) => [`${line.serviceId}|${p.runId}`, p] as const),
    ),
  );
  const points = series.runs.map((run) => ({
    at: when(run.at),
    ...Object.fromEntries(
      series.lines.flatMap((line) => {
        const point = amounts.get(`${line.serviceId}|${run.runId}`);
        return point ? [[line.serviceId, point.amountCents]] : [];
      }),
    ),
  }));
  const tick = { fill: colors.text, fontSize: 12 };
  const title = t("chartTitle", {
    address: titled(series.address),
    parcel: titled(series.parcel),
  });

  if (series.runs.length === 0) {
    return (
      <section aria-label={title} className="rounded-box bg-base-100 p-4 shadow-sm">
        <h2 className="font-semibold">{title}</h2>
        <p>{t("noSeries")}</p>
      </section>
    );
  }
  return (
    <ChartFigure
      title={title}
      note={t("chartNote")}
      height={300}
      chart={
        <ResponsiveContainer width="100%" height="100%">
          <LineChart accessibilityLayer={false} data={points}>
            <CartesianGrid stroke={colors.grid} strokeDasharray="3 3" />
            <XAxis dataKey="at" tick={tick} />
            <YAxis tick={tick} width={88} tickFormatter={(v) => cents(Number(v))} />
            <Tooltip
              contentStyle={{
                background: colors.surface,
                borderColor: colors.grid,
                color: colors.text,
              }}
              formatter={(value) => cents(Number(value))}
            />
            <Legend wrapperStyle={{ color: colors.text }} />
            {series.lines.map((line, i) => (
              <Line
                key={line.serviceId}
                type="monotone"
                dataKey={line.serviceId}
                name={name(line)}
                stroke={seriesColor(colors, i)}
                strokeWidth={2}
                connectNulls
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      }
      table={
        <table className="table table-sm">
          <caption className="sr-only">{title}</caption>
          <thead>
            <tr>
              <th scope="col">{t("run")}</th>
              {series.lines.map((line) => (
                <th key={line.serviceId} scope="col" className="text-end">
                  {name(line)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {series.runs.map((run) => (
              <tr key={run.runId}>
                <th scope="row">
                  <a className="link" href={`/rate-lab/runs/${run.runId}`}>
                    {when(run.at)}
                  </a>
                </th>
                {series.lines.map((line) => {
                  const point = amounts.get(`${line.serviceId}|${run.runId}`);
                  return (
                    <td key={line.serviceId} className="text-end">
                      {point ? cents(point.amountCents) : "—"}
                      {point &&
                        point.deliveryDays !== null &&
                        ` · ${t("days", { count: point.deliveryDays })}`}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      }
    />
  );
}
