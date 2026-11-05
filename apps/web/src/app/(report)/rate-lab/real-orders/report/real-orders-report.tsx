"use client";

import { useQuery } from "@tanstack/react-query";
import type { RealOrders, RealOrdersInput } from "@woolrus/contracts";
import { useFormatter, useTranslations } from "next-intl";
import {
  CarrierChart,
  LaneChart,
  ReasonChart,
  ServiceTable,
  Summary,
  useFigures,
} from "@/app/(app)/rate-lab/real-orders/real-orders-dashboard";
import { useChartColors } from "@/components/charts/theme";
import { useErrorMessage } from "@/lib/errors";
import { orpc } from "@/lib/orpc";
import { PageSection, ReportShell } from "../../../report-shell";

/** The Real orders report (SPEC-rate-lab "Exports"): headline numbers, charts, the service table. */
export function RealOrdersReport({
  input,
  autoPrint,
}: {
  input: RealOrdersInput;
  autoPrint: boolean;
}) {
  const t = useTranslations("rateLab.report");
  const format = useFormatter();
  const errorMessage = useErrorMessage();
  // The report never shows the alternatives table: skip loading its packages and quotes.
  const query = useQuery(
    orpc.rateLab.realOrders.queryOptions({ input: { ...input, alternativesLimit: 0 } }),
  );
  const data = query.data;
  // `to` is exclusive (a midnight, or now): the range reads as the days it covers, in UTC.
  const day = (at: Date) => format.dateTime(at, { dateStyle: "medium", timeZone: "UTC" });

  return (
    <ReportShell
      title={t("realOrdersTitle")}
      subtitle={
        data
          ? t("range", { from: day(data.from), to: day(new Date(data.to.getTime() - 1)) })
          : undefined
      }
      ready={Boolean(data)}
      error={query.error ? errorMessage(query.error) : undefined}
      autoPrint={autoPrint}
    >
      {data && <Loaded data={data} />}
    </ReportShell>
  );
}

function Loaded({ data }: { data: RealOrders }) {
  const t = useTranslations("rateLab.report");
  const tr = useTranslations("rateLab.realOrders");
  const colors = useChartColors();
  const { cents, percent } = useFigures();
  if (data.choice.packages === 0) return <p>{tr("empty")}</p>;
  return (
    <>
      <Summary data={data} narrow />
      <PageSection title={t("realOrdersCharts")}>
        <ReasonChart data={data} colors={colors} cents={cents} />
        <CarrierChart data={data} colors={colors} cents={cents} percent={percent} />
        <LaneChart lanes={data.laneCost} colors={colors} cents={cents} />
      </PageSection>
      <div className="print:break-before-page">
        <ServiceTable data={data} cents={cents} percent={percent} />
      </div>
    </>
  );
}
