"use client";

import { useQuery } from "@tanstack/react-query";
import type { RealOrders, RealOrdersInput, RealOrdersLaneWeek } from "@woolrus/contracts";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
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
import { Checkbox, SelectField, TextField } from "@/components/ui/fields";
import { useErrorMessage } from "@/lib/errors";
import { money } from "@/lib/money";
import { orpc } from "@/lib/orpc";
import { ReportLink, reportQuery } from "../report-link";

const ALL = "all";
/** The lane chart draws this many lanes, the busiest; its table lists every one. */
const LANES_CHARTED = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

const day = (at: Date) => at.toISOString().slice(0, 10);

export type Filters = {
  from: string;
  to: string;
  carrierId: string;
  serviceId: string;
  country: string;
  state: string;
  boxId: string;
  includeFake: boolean;
};

export function initialFilters(): Filters {
  const today = new Date();
  return {
    from: day(new Date(today.getTime() - 29 * DAY_MS)),
    to: day(today),
    carrierId: ALL,
    serviceId: ALL,
    country: ALL,
    state: ALL,
    boxId: ALL,
    includeFake: false,
  };
}

const chosen = (value: string) => (value === ALL ? undefined : value);

export function toInput(f: Filters): RealOrdersInput {
  return {
    from: f.from || undefined,
    to: f.to || undefined,
    carrierId: chosen(f.carrierId),
    serviceId: chosen(f.serviceId),
    country: chosen(f.country),
    state: chosen(f.state),
    boxId: chosen(f.boxId),
    includeFake: f.includeFake,
  };
}

const laneName = (lane: { country: string; state: string | null }) =>
  lane.state ? `${lane.country}-${lane.state}` : lane.country;

/** Real orders (SPEC-rate-lab): what real packages paid, and what else they were offered. */
export function RealOrdersDashboard() {
  const t = useTranslations("rateLab.realOrders");
  const errorMessage = useErrorMessage();
  const [filters, setFilters] = useState(initialFilters);
  const set = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    setFilters((current) => ({
      ...current,
      [key]: value,
      // A service belongs to a carrier and a state to a country: a new parent starts them over,
      // or the dashboard (and its CSV and PDF) would silently filter on the old one.
      ...(key === "carrierId" && { serviceId: ALL }),
      ...(key === "country" && { state: ALL }),
    }));

  const query = useQuery({
    ...orpc.rateLab.realOrders.queryOptions({ input: toInput(filters) }),
    placeholderData: (previous) => previous,
  });
  const data = query.data;
  const options = data?.options;
  const items = {
    carrierId: (options?.carriers ?? []).map((c) => ({ id: c.id, label: c.name })),
    serviceId: (options?.services ?? [])
      .filter((s) => filters.carrierId === ALL || s.carrierId === filters.carrierId)
      .map((s) => ({ id: s.id, label: s.name })),
    country: (options?.countries ?? []).map((c) => ({ id: c, label: c })),
    state: (options?.states ?? [])
      .filter((s) => filters.country === ALL || s.country === filters.country)
      .map((s) => ({ id: s.state, label: laneName(s) })),
    boxId: (options?.boxes ?? []).map((b) => ({ id: b.id, label: b.name })),
  };
  type Choice = keyof typeof items;
  // Options follow the date range: a choice the new range no longer offers is dropped, once the
  // answer for the current filters is in (not the previous one shown while it loads).
  if (options && !query.isPlaceholderData) {
    const gone = (Object.keys(items) as Choice[]).filter(
      (key) => filters[key] !== ALL && !items[key].some((item) => item.id === filters[key]),
    );
    if (gone.length > 0) {
      setFilters({ ...filters, ...Object.fromEntries(gone.map((key) => [key, ALL])) });
    }
  }
  const select = (label: string, key: Choice) => (
    <div className="w-44">
      <SelectField
        label={label}
        selectedKey={filters[key]}
        onSelectionChange={(value) => set(key, String(value))}
        options={[{ id: ALL, label: t("all") }, ...items[key]]}
      />
    </div>
  );

  return (
    <div className="space-y-6">
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
        {select(t("carrier"), "carrierId")}
        {select(t("service"), "serviceId")}
        {select(t("country"), "country")}
        {select(t("state"), "state")}
        {select(t("box"), "boxId")}
        <Checkbox isSelected={filters.includeFake} onChange={(v) => set("includeFake", v)}>
          {t("includeFake")}
        </Checkbox>
        <div className="ms-auto flex flex-wrap gap-2">
          <a
            className="btn btn-outline"
            href={`/api/rate-lab/real-orders/export.csv?${reportQuery(toInput(filters))}`}
            download
          >
            {t("exportCsv")}
          </a>
          <ReportLink href={`/rate-lab/real-orders/report?${reportQuery(toInput(filters))}`} />
        </div>
      </div>

      {query.isPending && <p>{t("loading")}</p>}
      {query.error && (
        <p role="alert" className="text-error">
          {errorMessage(query.error)}
        </p>
      )}
      {data &&
        (data.choice.packages === 0 ? (
          <p className="rounded-box bg-base-100 p-4 shadow-sm">{t("empty")}</p>
        ) : (
          <Dashboard data={data} />
        ))}
    </div>
  );
}

/** Money and share formatters the dashboard and its report share. */
export function useFigures() {
  const format = useFormatter();
  return {
    cents: (value: number) => money(format, value),
    percent: (part: number, whole: number) =>
      format.number(whole === 0 ? 0 : part / whole, { style: "percent", maximumFractionDigits: 1 }),
  };
}

function Dashboard({ data }: { data: RealOrders }) {
  const colors = useChartColors();
  const { cents, percent } = useFigures();

  return (
    <>
      <Summary data={data} />
      <div className="grid gap-4 lg:grid-cols-2">
        <ReasonChart data={data} colors={colors} cents={cents} />
        <CarrierChart data={data} colors={colors} cents={cents} percent={percent} />
      </div>
      <ServiceTable data={data} cents={cents} percent={percent} />
      <LaneChart lanes={data.laneCost} colors={colors} cents={cents} />
      <OverTable data={data} cents={cents} />
      <Alternatives data={data} cents={cents} />
    </>
  );
}

/** The headline numbers. */
export function Summary({ data, narrow = false }: { data: RealOrders; narrow?: boolean }) {
  const t = useTranslations("rateLab.realOrders");
  const format = useFormatter();
  const { cents, percent } = useFigures();
  const { choice, costVsCharged } = data;

  return (
    <section
      aria-label={t("summary")}
      className={`stats w-full bg-base-100 shadow-sm ${narrow ? "stats-vertical grid-cols-3" : "stats-vertical lg:stats-horizontal"}`}
    >
      <Tile title={t("tiles.packages")} value={format.number(choice.packages)} />
      <Tile
        title={t("tiles.onCheapest")}
        value={percent(choice.onCheapest, choice.packages)}
        desc={t("tiles.ofPackages", { count: choice.onCheapest })}
      />
      <Tile
        title={t("tiles.notCheapest")}
        value={percent(choice.notCheapest, choice.packages)}
        desc={t("tiles.ofPackages", { count: choice.notCheapest })}
      />
      <Tile title={t("tiles.overspend")} value={cents(choice.overspendCents)} />
      <Tile
        title={t("tiles.costVsCharged")}
        value={cents(costVsCharged.costCents)}
        desc={t("tiles.charged", { charged: cents(costVsCharged.chargedCents) })}
      />
      <Tile
        title={t("tiles.ordersOver")}
        value={format.number(costVsCharged.overCount)}
        desc={t("tiles.ofOrders", { orders: costVsCharged.orders })}
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

export type Cents = (value: number) => string;

/** Shared axis, grid and tooltip styling, in the theme's colours. */
function axes(colors: ChartColors, cents?: Cents) {
  const tick = { fill: colors.text, fontSize: 12 };
  return {
    grid: <CartesianGrid stroke={colors.grid} strokeDasharray="3 3" />,
    tooltip: (
      <Tooltip
        contentStyle={{ background: colors.surface, borderColor: colors.grid, color: colors.text }}
        formatter={cents ? (value) => cents(Number(value)) : undefined}
      />
    ),
    tick,
  };
}

export function ReasonChart({
  data,
  colors,
  cents,
}: {
  data: RealOrders;
  colors: ChartColors;
  cents: Cents;
}) {
  const animate = useChartAnimation();
  const t = useTranslations("rateLab.realOrders");
  const format = useFormatter();
  const rows = data.choice.byReason.map((r) => ({
    name: r.reason ? t(`reasons.${r.reason}`) : t("reasonNone"),
    packages: r.packages,
    overspendCents: r.overspendCents,
  }));
  const { grid, tooltip, tick } = axes(colors, cents);
  return (
    <ChartFigure
      title={t("reasonChart")}
      chart={
        <ResponsiveContainer width="100%" height="100%">
          <BarChart accessibilityLayer={false} data={rows} layout="vertical" margin={{ left: 24 }}>
            {grid}
            <XAxis type="number" tick={tick} tickFormatter={(v) => cents(Number(v))} />
            <YAxis type="category" dataKey="name" tick={tick} width={140} />
            {tooltip}
            <Bar
              isAnimationActive={animate}
              dataKey="overspendCents"
              name={t("columns.overspend")}
              fill={seriesColor(colors, 0)}
            />
          </BarChart>
        </ResponsiveContainer>
      }
      table={
        <table className="table table-sm">
          <caption className="sr-only">{t("reasonChart")}</caption>
          <thead>
            <tr>
              <th>{t("columns.reason")}</th>
              <th className="text-end">{t("columns.packages")}</th>
              <th className="text-end">{t("columns.overspend")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={3}>{t("allCheapest")}</td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.name}>
                <td>{r.name}</td>
                <td className="text-end">{format.number(r.packages)}</td>
                <td className="text-end">{cents(r.overspendCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      }
    />
  );
}

export function CarrierChart({
  data,
  colors,
  cents,
  percent,
}: {
  data: RealOrders;
  colors: ChartColors;
  cents: Cents;
  percent: (part: number, whole: number) => string;
}) {
  const animate = useChartAnimation();
  const t = useTranslations("rateLab.realOrders");
  const format = useFormatter();
  const { grid, tooltip, tick } = axes(colors, cents);
  const total = data.choice.packages;
  return (
    <ChartFigure
      title={t("carrierChart")}
      chart={
        <ResponsiveContainer width="100%" height="100%">
          <BarChart accessibilityLayer={false} data={data.byCarrier}>
            {grid}
            <XAxis dataKey="name" tick={tick} />
            <YAxis tick={tick} width={88} tickFormatter={(v) => cents(Number(v))} />
            {tooltip}
            <Bar
              isAnimationActive={animate}
              dataKey="spendCents"
              name={t("columns.spend")}
              fill={seriesColor(colors, 1)}
            />
          </BarChart>
        </ResponsiveContainer>
      }
      table={
        <table className="table table-sm">
          <caption className="sr-only">{t("carrierChart")}</caption>
          <thead>
            <tr>
              <th>{t("columns.carrier")}</th>
              <th className="text-end">{t("columns.packages")}</th>
              <th className="text-end">{t("columns.share")}</th>
              <th className="text-end">{t("columns.spend")}</th>
            </tr>
          </thead>
          <tbody>
            {data.byCarrier.map((c) => (
              <tr key={c.carrierId}>
                <td>{c.name}</td>
                <td className="text-end">{format.number(c.packages)}</td>
                <td className="text-end">{percent(c.packages, total)}</td>
                <td className="text-end">{cents(c.spendCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      }
    />
  );
}

export function ServiceTable({
  data,
  cents,
  percent,
}: {
  data: RealOrders;
  cents: Cents;
  percent: (part: number, whole: number) => string;
}) {
  const t = useTranslations("rateLab.realOrders");
  const format = useFormatter();
  return (
    <section className="space-y-2 rounded-box bg-base-100 p-4 shadow-sm">
      <h2 className="font-semibold">{t("serviceTable")}</h2>
      <div className="overflow-x-auto">
        <table className="table table-sm">
          <thead>
            <tr>
              <th>{t("columns.carrier")}</th>
              <th>{t("columns.service")}</th>
              <th className="text-end">{t("columns.packages")}</th>
              <th className="text-end">{t("columns.share")}</th>
              <th className="text-end">{t("columns.spend")}</th>
            </tr>
          </thead>
          <tbody>
            {data.byService.map((s) => (
              <tr key={s.serviceId}>
                <td>{s.carrierName}</td>
                <td>{s.name}</td>
                <td className="text-end">{format.number(s.packages)}</td>
                <td className="text-end">{percent(s.packages, data.choice.packages)}</td>
                <td className="text-end">{cents(s.spendCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function LaneChart({
  lanes,
  colors,
  cents,
}: {
  lanes: RealOrdersLaneWeek[];
  colors: ChartColors;
  cents: Cents;
}) {
  const animate = useChartAnimation();
  const t = useTranslations("rateLab.realOrders");
  const format = useFormatter();
  const totals = new Map<string, number>();
  for (const lane of lanes)
    totals.set(laneName(lane), (totals.get(laneName(lane)) ?? 0) + lane.packages);
  const charted = [...totals]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, LANES_CHARTED)
    .map(([name]) => name);
  const weeks = [...new Set(lanes.map((l) => l.week))].sort();
  const points = weeks.map((week) => ({
    week,
    ...Object.fromEntries(
      lanes
        .filter((l) => l.week === week && charted.includes(laneName(l)))
        .map((l) => [laneName(l), l.medianCents]),
    ),
  }));
  const { grid, tooltip, tick } = axes(colors, cents);
  return (
    <ChartFigure
      title={t("laneChart")}
      note={t("laneNote", { count: charted.length })}
      height={280}
      chart={
        <ResponsiveContainer width="100%" height="100%">
          <LineChart accessibilityLayer={false} data={points}>
            {grid}
            <XAxis dataKey="week" tick={tick} />
            <YAxis tick={tick} width={88} tickFormatter={(v) => cents(Number(v))} />
            {tooltip}
            <Legend wrapperStyle={{ color: colors.text }} />
            {charted.map((name, i) => (
              <Line
                isAnimationActive={animate}
                key={name}
                type="monotone"
                dataKey={name}
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
          <caption className="sr-only">{t("laneChart")}</caption>
          <thead>
            <tr>
              <th>{t("columns.lane")}</th>
              <th>{t("columns.week")}</th>
              <th className="text-end">{t("columns.packages")}</th>
              <th className="text-end">{t("columns.median")}</th>
              <th className="text-end">{t("columns.mean")}</th>
            </tr>
          </thead>
          <tbody>
            {lanes.map((l) => (
              <tr key={`${laneName(l)}|${l.week}`}>
                <td>{laneName(l)}</td>
                <td>{l.week}</td>
                <td className="text-end">{format.number(l.packages)}</td>
                <td className="text-end">{cents(l.medianCents)}</td>
                <td className="text-end">{cents(l.meanCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      }
    />
  );
}

function OverTable({ data, cents }: { data: RealOrders; cents: Cents }) {
  const t = useTranslations("rateLab.realOrders");
  const { over, overCount } = data.costVsCharged;
  return (
    <section className="space-y-2 rounded-box bg-base-100 p-4 shadow-sm">
      <h2 className="font-semibold">{t("overTitle")}</h2>
      {overCount > over.length && (
        <p className="text-sm opacity-70">
          {t("overNote", { shown: over.length, total: overCount })}
        </p>
      )}
      {over.length === 0 ? (
        <p>{t("overNone")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>{t("columns.order")}</th>
                <th className="text-end">{t("columns.cost")}</th>
                <th className="text-end">{t("columns.charged")}</th>
                <th className="text-end">{t("columns.gap")}</th>
              </tr>
            </thead>
            <tbody>
              {over.map((o) => (
                <tr key={o.orderId}>
                  <td>
                    <a className="link" href={`/orders/${o.orderId}`}>
                      #{o.number}
                    </a>
                  </td>
                  <td className="text-end">{cents(o.costCents)}</td>
                  <td className="text-end">{cents(o.chargedCents)}</td>
                  <td className="text-end">{cents(o.costCents - o.chargedCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Alternatives({ data, cents }: { data: RealOrders; cents: Cents }) {
  const t = useTranslations("rateLab.realOrders");
  const format = useFormatter();
  const { packages, total } = data.alternatives;
  return (
    <section className="space-y-2 rounded-box bg-base-100 p-4 shadow-sm">
      <h2 className="font-semibold">{t("alternatives")}</h2>
      {total > packages.length && (
        <p className="text-sm opacity-70">
          {t("alternativesNote", { shown: packages.length, total })}
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="table table-sm" aria-label={t("alternatives")}>
          <thead>
            <tr>
              <th>{t("columns.package")}</th>
              <th>{t("columns.purchased")}</th>
              <th>{t("columns.lane")}</th>
              <th>{t("columns.reason")}</th>
              <th>{t("columns.quotes")}</th>
            </tr>
          </thead>
          <tbody>
            {packages.map((p) => (
              <tr key={p.labelId} className="align-top">
                <td>
                  <a className="link" href={`/orders/${p.orderId}`}>
                    {t("packageOf", { order: p.orderNumber, number: p.packageNumber })}
                  </a>
                </td>
                <td>{format.dateTime(p.purchasedAt, { dateStyle: "medium" })}</td>
                <td>{laneName(p)}</td>
                <td>{p.reason ? t(`reasons.${p.reason}`) : "—"}</td>
                <td>
                  <ul className="space-y-1">
                    {p.quotes.map((q) => (
                      <li key={q.id} className={q.bought ? "font-semibold" : undefined}>
                        {q.carrierName} {q.serviceName}: {cents(q.amountCents)}
                        {q.deliveryDays !== null && ` · ${t("days", { count: q.deliveryDays })}`}
                        {q.bought && (
                          <span className="badge badge-sm badge-primary ms-2">{t("bought")}</span>
                        )}
                        {q.cheapest && (
                          <span className="badge badge-sm badge-success ms-2">{t("cheapest")}</span>
                        )}
                        {q.quoteOnly && (
                          <span className="badge badge-sm badge-ghost ms-2">{t("quoteOnly")}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
