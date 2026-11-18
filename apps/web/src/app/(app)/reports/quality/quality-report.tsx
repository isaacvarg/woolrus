"use client";

import { useQuery } from "@tanstack/react-query";
import {
  type FulfillmentStage,
  IssueListStatus,
  isQueryTrue,
  QualityIssueSeverity,
  type QualityPersonRef,
  type QualityReport as Report,
  ReportRange,
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
import { Checkbox, SelectField } from "@/components/ui/fields";
import { useErrorMessage } from "@/lib/errors";
import { orpc } from "@/lib/orpc";
import { ReportBody, reportView } from "../report-view";
import { useReportRange } from "../use-report-range";

const ANY = "any";
type FilterKey = "severity" | "status" | "customerReported";

/** Severity, status and customer-reported, kept in the URL next to the range so a link shares the view. */
function useFilters() {
  const params = useSearchParams();
  const severity = QualityIssueSeverity.safeParse(params.get("severity")).data;
  const status = IssueListStatus.safeParse(params.get("status")).data ?? "all";
  const customerReported = isQueryTrue(params.get("customerReported"));
  const set = (key: FilterKey, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value === null) next.delete(key);
    else next.set(key, value);
    const search = next.toString();
    window.history.pushState(null, "", `${window.location.pathname}${search ? `?${search}` : ""}`);
  };
  return { severity, status, customerReported, set };
}

/** A bucket's first day (YYYY-MM-DD) read back at UTC midnight, so no zone moves it. */
function useBucket() {
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
  const t = useTranslations("reports.quality");
  return (person: QualityPersonRef) =>
    person.id === null ? t("nobody") : (person.name ?? t("unnamed"));
}

/**
 * Reports → Quality (FR-QI-07, SPEC-reporting "Quality"): issues per day or week by type, stage
 * and responsible person, each person's rate per 1,000 units, blocked scans and voids. Counts are
 * shown as training signals, so people are listed by name, never ranked.
 */
export function QualityReport() {
  const t = useTranslations("reports.quality");
  const tIssues = useTranslations("issues");
  const errorMessage = useErrorMessage();
  const { range } = useReportRange();
  const { severity, status, customerReported, set } = useFilters();
  const input = { ...range, severity, status, customerReported: customerReported || undefined };
  const valid = ReportRange.safeParse(range).success;
  const query = useQuery({
    ...orpc.reports.quality.queryOptions({ input }),
    enabled: valid,
    placeholderData: (previous) => previous,
  });
  const { data, loading, busy, error } = reportView(query, valid);
  const exportParams = { from: range.from, to: range.to };

  return (
    <div className="space-y-6">
      <p className="text-sm opacity-80">{t("intro")}</p>
      <div className="flex flex-wrap items-end gap-4">
        <div className="w-44">
          <SelectField
            label={t("severity")}
            selectedKey={severity ?? ANY}
            onSelectionChange={(key) => set("severity", key === ANY ? null : String(key))}
            options={[
              { id: ANY, label: t("anySeverity") },
              ...QualityIssueSeverity.options.map((s) => ({
                id: s,
                label: tIssues(`severities.${s}`),
              })),
            ]}
          />
        </div>
        <div className="w-52">
          <SelectField
            label={t("status")}
            selectedKey={status}
            onSelectionChange={(key) => set("status", key === "all" ? null : String(key))}
            options={IssueListStatus.options.map((s) => ({ id: s, label: t(`statuses.${s}`) }))}
          />
        </div>
        <Checkbox
          isSelected={customerReported}
          onChange={(on) => set("customerReported", on ? "true" : null)}
        >
          {t("customerReported")}
        </Checkbox>
        {valid && (
          <div className="ms-auto">
            <ExportCsvLink
              path="/api/reports/quality.csv"
              params={{
                ...exportParams,
                severity,
                status: status === "all" ? undefined : status,
                customerReported: customerReported ? "true" : undefined,
              }}
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
          <p className="rounded-box bg-base-100 p-4 font-semibold shadow-sm">
            {t("total", { count: data.total })}
          </p>
          {data.total > 0 && <Breakdowns data={data} />}
          {data.people.length > 0 && <Rates data={data} />}
          <Scans data={data} exportParams={exportParams} />
          <Voids data={data} />
        </ReportBody>
      )}
    </div>
  );
}

function Breakdowns({ data }: { data: Report }) {
  const t = useTranslations("reports.quality");
  const tIssues = useTranslations("issues");
  const personName = usePersonName();
  const names = new Map<string | null, string>(
    data.people.map((r) => [r.person.id, personName(r.person)]),
  );
  const stage = (s: FulfillmentStage | null) => (s ? t(`stages.${s}`) : t("noOrigin"));
  return (
    <>
      <Breakdown
        title={t("byType")}
        data={data}
        breakdown={data.byType}
        label={(k) => tIssues(`types.${k}`)}
      />
      <Breakdown
        title={t("byDiscovered")}
        data={data}
        breakdown={data.byDiscoveredStage}
        label={stage}
      />
      <Breakdown title={t("byOrigin")} data={data} breakdown={data.byOriginStage} label={stage} />
      <Breakdown
        title={t("byPerson")}
        data={data}
        breakdown={data.byPerson}
        label={(id) => (id === null ? t("nobody") : (names.get(id) ?? t("unnamed")))}
      />
    </>
  );
}

type Counts<K> = {
  series: { bucket: string; key: K; count: number }[];
  totals: { key: K; count: number }[];
};

/** One dimension's issues per bucket, stacked by key, with the same figures as a table. */
function Breakdown<K extends string | null>({
  title,
  data,
  breakdown,
  label,
}: {
  title: string;
  data: Report;
  breakdown: Counts<K>;
  label: (key: K) => string;
}) {
  const t = useTranslations("reports.quality");
  const format = useFormatter();
  const colors = useChartColors();
  const animate = useChartAnimation();
  const bucket = useBucket();
  // Recharts keys by string; null (nobody, not recorded) gets its own.
  const id = (key: K) => (key === null ? "_none" : key);
  const keys = breakdown.totals.map((r) => r.key);
  const count = (b: string, key: K) =>
    breakdown.series.find((c) => c.bucket === b && c.key === key)?.count ?? 0;
  const rows = data.buckets.map((b) => ({
    bucket: b,
    ...Object.fromEntries(keys.map((k) => [id(k), count(b, k)])),
  }));
  const tick = { fill: colors.text, fontSize: 12 };

  return (
    <ChartFigure
      title={title}
      note={t("chartNote", { size: data.bucketSize })}
      height={260}
      chart={
        <ResponsiveContainer width="100%" height="100%">
          <BarChart accessibilityLayer={false} data={rows} margin={{ top: 8, right: 16 }}>
            <CartesianGrid stroke={colors.grid} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="bucket" tick={tick} tickFormatter={bucket.short} minTickGap={16} />
            <YAxis tick={tick} allowDecimals={false} width={40} />
            <Tooltip
              cursor={{ fill: colors.grid, opacity: 0.4 }}
              contentStyle={{
                background: colors.surface,
                borderColor: colors.grid,
                color: colors.text,
              }}
              labelFormatter={(b) => bucket.long(String(b))}
              formatter={(value) => format.number(Number(value))}
            />
            <Legend wrapperStyle={{ color: colors.text }} />
            {keys.map((k, i) => (
              <Bar
                key={id(k)}
                isAnimationActive={animate}
                dataKey={id(k)}
                name={label(k)}
                stackId="issues"
                fill={seriesColor(colors, i)}
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
              <th>{t(`bucket.${data.bucketSize}`)}</th>
              {keys.map((k) => (
                <th key={id(k)} className="text-end">
                  {label(k)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.bucket}>
                <td>{bucket.long(row.bucket)}</td>
                {keys.map((k) => (
                  <td key={id(k)} className="text-end">
                    {format.number(count(row.bucket, k))}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th>{t("totalColumn")}</th>
              {breakdown.totals.map((r) => (
                <th key={id(r.key)} className="text-end">
                  {format.number(r.count)}
                </th>
              ))}
            </tr>
          </tfoot>
        </table>
      }
    />
  );
}

function Rates({ data }: { data: Report }) {
  const t = useTranslations("reports.quality");
  const format = useFormatter();
  const personName = usePersonName();
  return (
    <section className="space-y-2 rounded-box bg-base-100 p-4 shadow-sm">
      <h2 className="font-semibold">{t("ratesTitle")}</h2>
      <p className="text-sm opacity-70">{t("ratesNote")}</p>
      <div className="overflow-x-auto">
        <table className="table table-sm" data-testid="quality-rates">
          <thead>
            <tr>
              <th>{t("person")}</th>
              <th>{t("stage")}</th>
              <th className="text-end">{t("issues")}</th>
              <th className="text-end">{t("units")}</th>
              <th className="text-end">{t("per1000")}</th>
            </tr>
          </thead>
          <tbody>
            {data.people.map((row) => (
              <tr key={`${row.person.id}:${row.stage}`}>
                <td>{personName(row.person)}</td>
                <td>{row.stage ? t(`stages.${row.stage}`) : t("noOrigin")}</td>
                <td className="text-end">{format.number(row.issues)}</td>
                <td className="text-end">
                  {row.units === null ? t("noUnits") : format.number(row.units)}
                </td>
                <td className="text-end">
                  {row.per1000 !== null
                    ? format.number(row.per1000, { maximumFractionDigits: 1 })
                    : row.units === null
                      ? t("noUnits")
                      : t("belowFloor")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const SCAN_KINDS = ["notOnOrder", "alreadyDone", "otherPackage"] as const;
const KIND_CODE = {
  notOnOrder: "NOT_ON_ORDER",
  alreadyDone: "ALREADY_DONE",
  otherPackage: "OTHER_PACKAGE",
} as const;

function Scans({
  data,
  exportParams,
}: {
  data: Report;
  exportParams: { from: string; to: string };
}) {
  const t = useTranslations("reports.quality");
  const format = useFormatter();
  const personName = usePersonName();
  return (
    <section className="space-y-2 rounded-box bg-base-100 p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="font-semibold">{t("scansTitle")}</h2>
        <ExportCsvLink
          path="/api/reports/scan-misses.csv"
          params={exportParams}
          label={t("exportScans")}
        />
      </div>
      <p className="text-sm opacity-70">{t("scansNote")}</p>
      {data.scans.length === 0 ? (
        <p>{t("noScans")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="table table-sm" data-testid="quality-scans">
            <thead>
              <tr>
                <th>{t("stage")}</th>
                <th>{t("person")}</th>
                {SCAN_KINDS.map((k) => (
                  <th key={k} className="text-end">
                    {t(`kinds.${KIND_CODE[k]}`)}
                  </th>
                ))}
                <th className="text-end">{t("scansTotal")}</th>
                <th className="border-s border-base-300 text-end">{t("kinds.UNKNOWN_CODE")}</th>
              </tr>
            </thead>
            <tbody>
              {data.scans.map((row) => (
                <tr key={`${row.stage}:${row.person.id}`}>
                  <td>{t(`stages.${row.stage}`)}</td>
                  <td>{personName(row.person)}</td>
                  {SCAN_KINDS.map((k) => (
                    <td key={k} className="text-end">
                      {format.number(row[k])}
                    </td>
                  ))}
                  <td className="text-end font-semibold">
                    {format.number(row.notOnOrder + row.alreadyDone + row.otherPackage)}
                  </td>
                  <td className="border-s border-base-300 text-end">
                    {format.number(row.unknownCode)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Voids({ data }: { data: Report }) {
  const t = useTranslations("reports.quality");
  const tVoids = useTranslations("voids.page.outcomes");
  const format = useFormatter();
  return (
    <section className="space-y-2 rounded-box bg-base-100 p-4 shadow-sm">
      <h2 className="font-semibold">{t("voidsTitle")}</h2>
      {data.voids.length === 0 ? (
        <p>{t("noVoids")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="table table-sm" data-testid="quality-voids">
            <thead>
              <tr>
                <th>{t("stage")}</th>
                <th>{t("resolution")}</th>
                <th className="text-end">{t("voids")}</th>
                <th className="text-end">{t("units")}</th>
              </tr>
            </thead>
            <tbody>
              {data.voids.map((row) => (
                <tr key={`${row.stage}:${row.resolution}`}>
                  <td>{t(`stages.${row.stage}`)}</td>
                  <td>{row.resolution ? tVoids(row.resolution) : t("unresolved")}</td>
                  <td className="text-end">{format.number(row.voids)}</td>
                  <td className="text-end">{format.number(row.units)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
