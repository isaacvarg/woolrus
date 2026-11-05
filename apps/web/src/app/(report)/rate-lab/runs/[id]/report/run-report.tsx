"use client";

import { useQuery } from "@tanstack/react-query";
import {
  LAB_RUN_TREND_RUNS,
  type LabCombination,
  type LabRunDetail,
  type LabRunTrend,
} from "@woolrus/contracts";
import { useFormatter, useTranslations } from "next-intl";
import {
  FailuresCard,
  Header,
  MovesCard,
  PicksCard,
  QuoteTable,
  useCombinationName,
  WinsCard,
} from "@/app/(app)/rate-lab/runs/[id]/run-detail";
import { useErrorMessage } from "@/lib/errors";
import { money } from "@/lib/money";
import { orpc } from "@/lib/orpc";
import { PageSection, ReportShell } from "../../../../report-shell";

/** A run's report (SPEC-rate-lab "Exports"): summary, insights, trends, then every quote. */
export function RunReport({ runId, autoPrint }: { runId: string; autoPrint: boolean }) {
  const t = useTranslations("rateLab.report");
  const errorMessage = useErrorMessage();
  const detail = useQuery(orpc.rateLab.run.queryOptions({ input: { id: runId } }));
  const trends = useQuery(orpc.rateLab.runTrends.queryOptions({ input: { id: runId } }));
  const error = detail.error ?? trends.error;

  return (
    <ReportShell
      title={t("runTitle")}
      ready={Boolean(detail.data && trends.data)}
      error={error ? errorMessage(error) : undefined}
      autoPrint={autoPrint}
    >
      {detail.data && trends.data && <Loaded detail={detail.data} trends={trends.data} />}
    </ReportShell>
  );
}

function Loaded({ detail, trends }: { detail: LabRunDetail; trends: LabRunTrend[] }) {
  const t = useTranslations("rateLab.report");
  const names = useCombinationName();
  const picks = new Map(detail.insights.picks.map((p) => [p.key, p]));
  const byKey = new Map(detail.combinations.map((c) => [c.key, c]));
  const nameOf = (key: string) => {
    const c = byKey.get(key);
    return c ? names(c) : key;
  };
  const trendOf = new Map(trends.map((x) => [x.key, x]));
  const charted = detail.combinations.filter((c) => trendOf.has(c.key));

  return (
    <>
      <Header detail={detail} actions={false} />
      <PageSection title={t("insights")}>
        <PicksCard combinations={detail.combinations} picks={picks} />
        <MovesCard detail={detail} nameOf={nameOf} />
        <WinsCard detail={detail} />
        <FailuresCard detail={detail} nameOf={nameOf} />
      </PageSection>
      <PageSection title={t("trendsTitle")} hint={t("trendsHint", { count: LAB_RUN_TREND_RUNS })}>
        {charted.length === 0 ? (
          <p>{t("noTrends")}</p>
        ) : (
          <ul className="grid grid-cols-2 gap-3">
            {charted.map((c) => (
              <TrendCard key={c.key} combination={c} trend={trendOf.get(c.key) as LabRunTrend} />
            ))}
          </ul>
        )}
      </PageSection>
      <div className="print:break-before-page">
        <QuoteTable combinations={detail.combinations} picks={picks} filterable={false} />
      </div>
    </>
  );
}

const WIDTH = 240;
const HEIGHT = 48;
const PAD = 4;

/** A combination's cheapest price per run as a small line; its figures are the text beside it. */
function TrendCard({ combination, trend }: { combination: LabCombination; trend: LabRunTrend }) {
  const t = useTranslations("rateLab.report");
  const format = useFormatter();
  const names = useCombinationName();
  const name = names(combination);
  const amounts = trend.prices.map((p) => p.amountCents);
  const low = Math.min(...amounts);
  const high = Math.max(...amounts);
  const x = (i: number) =>
    amounts.length === 1 ? WIDTH / 2 : PAD + (i * (WIDTH - 2 * PAD)) / (amounts.length - 1);
  const y = (cents: number) =>
    high === low ? HEIGHT / 2 : HEIGHT - PAD - ((cents - low) * (HEIGHT - 2 * PAD)) / (high - low);
  const points = amounts.map((cents, i) => `${x(i)},${y(cents)}`).join(" ");
  const latest = amounts.at(-1) as number;

  return (
    <li className="break-inside-avoid space-y-1 rounded-box border border-base-300 p-3">
      <h3 className="text-sm font-semibold">{name}</h3>
      <svg
        aria-hidden="true"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-12 w-full text-primary"
        preserveAspectRatio="none"
      >
        <polyline points={points} fill="none" stroke="currentColor" strokeWidth={2} />
        {amounts.map((cents, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: one dot per run, in run order.
          <circle key={i} cx={x(i)} cy={y(cents)} r={2.5} fill="currentColor" />
        ))}
      </svg>
      <p className="text-xs">
        {t("trendFigures", {
          runs: amounts.length,
          latest: money(format, latest),
          low: money(format, low),
          high: money(format, high),
        })}
      </p>
    </li>
  );
}
