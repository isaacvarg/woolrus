"use client";

import { useQuery } from "@tanstack/react-query";
import { LAB_TRENDS_REPORT_MAX, type LabTrendsReport } from "@woolrus/contracts";
import { useTranslations } from "next-intl";
import {
  type Filters,
  Heatmap,
  SeriesFigure,
  toInput,
} from "@/app/(app)/rate-lab/trends/trends-view";
import { useErrorMessage } from "@/lib/errors";
import { orpc } from "@/lib/orpc";
import { PageSection, ReportShell } from "../../../report-shell";

/** The Trends report (SPEC-rate-lab "Exports"): the heatmap, then a chart per combination. */
export function TrendsReport({ filters, autoPrint }: { filters: Filters; autoPrint: boolean }) {
  const t = useTranslations("rateLab.report");
  const errorMessage = useErrorMessage();
  const report = useQuery(orpc.rateLab.trendsReport.queryOptions({ input: toInput(filters) }));
  const filtered =
    filters.addressGroupIds.length + filters.parcelGroupIds.length + filters.carrierIds.length >
      0 ||
    filters.from !== "" ||
    filters.to !== "";

  return (
    <ReportShell
      title={t("trendsReportTitle")}
      subtitle={t(filtered ? "filtersSome" : "filtersAll")}
      ready={Boolean(report.data)}
      error={report.error ? errorMessage(report.error) : undefined}
      autoPrint={autoPrint}
    >
      {report.data && <Loaded report={report.data} />}
    </ReportShell>
  );
}

function Loaded({ report }: { report: LabTrendsReport }) {
  const t = useTranslations("rateLab.report");
  const tt = useTranslations("rateLab.trends");
  if (report.grid.cells.length === 0) return <p>{tt("empty")}</p>;
  return (
    <>
      <Heatmap grid={report.grid} />
      <PageSection title={t("charts")}>
        {report.omitted > 0 && (
          <p role="note" className="alert alert-warning">
            {t("omitted", { count: report.omitted, max: LAB_TRENDS_REPORT_MAX })}
          </p>
        )}
        {report.series.length === 0 ? (
          <p>{t("noCharts")}</p>
        ) : (
          report.series.map((series) => (
            <div key={`${series.address.id}|${series.parcel.id}`} className="break-inside-avoid">
              <SeriesFigure series={series} />
            </div>
          ))
        )}
      </PageSection>
    </>
  );
}
