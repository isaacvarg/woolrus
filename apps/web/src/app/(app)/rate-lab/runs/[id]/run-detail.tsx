"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  LabCombination,
  LabPick,
  LabQuote,
  LabRunDetail,
  ShippingProviderId,
} from "@woolrus/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { money } from "@/app/(app)/qa/[orderId]/money";
import { Button, SelectField } from "@/components/ui/fields";
import { useErrorMessage } from "@/lib/errors";
import { orpc } from "@/lib/orpc";
import { ReportLink } from "../../report-link";
import { duration, isActive, Side, statusBadge, useMessage } from "../runs-manager";

/** A queued or running run refreshes like the runs list does. */
const ACTIVE_REFRESH_MS = 3_000;
const ALL = "all";

type Format = ReturnType<typeof useFormatter>;

/** "Address × Parcel", or the lane and "Typed in" for a one-off's typed address or parcel. */
export function useCombinationName() {
  const t = useTranslations("rateLab.run");
  return (c: LabCombination) => {
    const lane = c.lane.state ? `${c.lane.country}-${c.lane.state}` : c.lane.country;
    return `${c.address?.title ?? lane} × ${c.parcel?.title ?? t("typedParcel")}`;
  };
}

/** A run's page (SPEC-rate-lab "Run detail"): header, insight cards, then every quote. */
export function RunDetail({ runId }: { runId: string }) {
  const t = useTranslations("rateLab.run");
  const errorMessage = useErrorMessage();
  const detail = useQuery(
    orpc.rateLab.run.queryOptions({
      input: { id: runId },
      refetchInterval: (query) =>
        query.state.data && isActive(query.state.data.run) ? ACTIVE_REFRESH_MS : false,
    }),
  );

  return (
    <div className="space-y-6">
      <Link href="/rate-lab/runs" className="link link-hover text-sm">
        ← {t("back")}
      </Link>
      {detail.isPending && <p>{t("loading")}</p>}
      {detail.error && (
        <p role="alert" className="alert alert-error">
          {errorMessage(detail.error)}
        </p>
      )}
      {detail.data && <Loaded detail={detail.data} />}
    </div>
  );
}

function Loaded({ detail }: { detail: LabRunDetail }) {
  const names = useCombinationName();
  const picks = new Map(detail.insights.picks.map((p) => [p.key, p]));
  const byKey = new Map(detail.combinations.map((c) => [c.key, c]));
  const nameOf = (key: string) => {
    const c = byKey.get(key);
    return c ? names(c) : key;
  };
  return (
    <>
      <Header detail={detail} />
      <div className="grid gap-4 lg:grid-cols-2">
        <PicksCard combinations={detail.combinations} picks={picks} />
        <MovesCard detail={detail} nameOf={nameOf} />
        <WinsCard detail={detail} />
        <FailuresCard detail={detail} nameOf={nameOf} />
      </div>
      <QuoteTable combinations={detail.combinations} picks={picks} />
    </>
  );
}

/** The run's summary; the report prints it without the buttons. */
export function Header({
  detail: { run, selection },
  actions = true,
}: {
  detail: LabRunDetail;
  actions?: boolean;
}) {
  const t = useTranslations("rateLab.run");
  const tr = useTranslations("rateLab.runs");
  const format = useFormatter();
  const message = useMessage();
  const errorMessage = useErrorMessage();
  const router = useRouter();
  const queryClient = useQueryClient();
  // One key per page view: a retried press can't queue two runs.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const again = useMutation(
    orpc.rateLab.startRun.mutationOptions({
      onSuccess: async (next) => {
        await queryClient.invalidateQueries({ queryKey: orpc.rateLab.runs.key() });
        router.push(`/rate-lab/runs/${next.id}`);
      },
    }),
  );
  const fact = (label: string, value: React.ReactNode) => (
    <div>
      <dt className="text-sm opacity-70">{label}</dt>
      <dd>{value}</dd>
    </div>
  );

  return (
    <section className="space-y-4 rounded-box bg-base-100 p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-2xl font-semibold">
          {t("heading", {
            at: format.dateTime(run.startedAt ?? run.createdAt, {
              dateStyle: "medium",
              timeStyle: "short",
            }),
          })}
        </h2>
        <span className={`badge ${statusBadge[run.status]}`}>{tr(`status_${run.status}`)}</span>
        {run.fake && <span className="badge badge-outline">{tr("fake")}</span>}
        {actions && <ReportLink className="ms-auto" href={`/rate-lab/runs/${run.id}/report`} />}
        {actions && run.kind === "SUITE" && (
          <Button
            className="btn-outline"
            isPending={again.isPending}
            onPress={() => again.mutate({ idempotencyKey, selection })}
          >
            {t("runAgain")}
          </Button>
        )}
      </div>
      {again.error && (
        <p role="alert" className="text-error">
          {errorMessage(again.error)}
        </p>
      )}
      {run.error && <p className="text-error">{message(run.error)}</p>}
      <dl className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
        {fact(tr("startedBy"), run.startedBy?.name ?? "—")}
        {fact(tr("duration"), duration(run, format))}
        {fact(
          tr("combinations"),
          run.status === "RUNNING"
            ? tr("progress", { done: run.completedCombinations, total: run.combinations })
            : run.combinations,
        )}
        {fact(tr("quotes"), run.quoteCount)}
        {fact(tr("failures"), run.failureCount)}
        {fact(
          tr("groups"),
          <div className="text-sm">
            <Side label={tr("addresses")} all={tr("allAddresses")} side={run.addresses} />
            <Side label={tr("parcels")} all={tr("allParcels")} side={run.parcels} />
          </div>,
        )}
      </dl>
    </section>
  );
}

function Card({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2 rounded-box bg-base-100 p-4 shadow-sm">
      <h3 className="text-lg font-semibold">{title}</h3>
      {hint && <p className="text-sm opacity-70">{hint}</p>}
      {children}
    </section>
  );
}

/** A quote in one line: carrier, service, price and days. */
function quoteText(t: ReturnType<typeof useTranslations>, format: Format, q: LabQuote) {
  const days = q.deliveryDays === null ? "" : `, ${t("days", { count: q.deliveryDays })}`;
  return `${q.carrierName} ${q.serviceName}: ${money(format, q.amountCents)}${days}`;
}

export function PicksCard({
  combinations,
  picks,
}: {
  combinations: LabCombination[];
  picks: Map<string, LabPick>;
}) {
  const t = useTranslations("rateLab.run");
  const format = useFormatter();
  const names = useCombinationName();
  const shown = (c: LabCombination, id: string | null, quoteOnly: boolean) => {
    const q = c.quotes.find((x) => x.id === id);
    if (!q) return <span className="opacity-70">—</span>;
    return (
      <>
        {quoteText(t, format, q)}
        {quoteOnly && <span className="badge badge-outline badge-sm ms-1">{t("quoteOnly")}</span>}
      </>
    );
  };
  return (
    <Card title={t("picksTitle")} hint={t("picksHint")}>
      <div className="max-h-96 overflow-auto print:max-h-none print:overflow-visible">
        <table className="table table-sm" aria-label={t("picksTitle")}>
          <thead>
            <tr>
              <th>{t("combination")}</th>
              <th>{t("cheapest")}</th>
              <th>{t("fastest")}</th>
            </tr>
          </thead>
          <tbody>
            {combinations.map((c) => {
              const pick = picks.get(c.key);
              return (
                <tr key={c.key}>
                  <td>{names(c)}</td>
                  {pick?.failed ? (
                    <td colSpan={2} className="text-error">
                      {t("noQuotes")}
                    </td>
                  ) : (
                    <>
                      <td>
                        {shown(c, pick?.cheapestId ?? null, pick?.cheapestQuoteOnly ?? false)}
                      </td>
                      <td>{shown(c, pick?.fastestId ?? null, pick?.fastestQuoteOnly ?? false)}</td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function MovesCard({
  detail,
  nameOf,
}: {
  detail: LabRunDetail;
  nameOf: (key: string) => string;
}) {
  const t = useTranslations("rateLab.run");
  const format = useFormatter();
  const { moves } = detail.insights;
  const compared = detail.combinations.some((c) => c.comparedWith);
  const cents = (value: number | null) => (value === null ? "—" : money(format, value));
  return (
    <Card title={t("movesTitle")} hint={t("movesHint")}>
      {!compared ? (
        <p>{t("noEarlierRun")}</p>
      ) : moves.length === 0 ? (
        <p>{t("noMoves")}</p>
      ) : (
        <div className="max-h-96 overflow-auto print:max-h-none print:overflow-visible">
          <table className="table table-sm" aria-label={t("movesTitle")}>
            <thead>
              <tr>
                <th>{t("combination")}</th>
                <th>{t("service")}</th>
                <th className="text-right">{t("before")}</th>
                <th className="text-right">{t("now")}</th>
                <th className="text-right">{t("change")}</th>
              </tr>
            </thead>
            <tbody>
              {moves.map((m) => (
                <tr key={`${m.combinationKey}:${m.serviceId}`} data-testid="lab-price-move">
                  <td>{nameOf(m.combinationKey)}</td>
                  <td>
                    {m.carrierName} {m.serviceName}
                  </td>
                  <td className="text-right tabular-nums">{cents(m.previousCents)}</td>
                  <td className="text-right tabular-nums">{cents(m.currentCents)}</td>
                  <td className="text-right tabular-nums">
                    {m.kind === "CHANGED" && m.changePct !== null
                      ? format.number(m.changePct / 100, {
                          style: "percent",
                          maximumFractionDigits: 1,
                          signDisplay: "always",
                        })
                      : t(`move_${m.kind}`)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function WinsCard({ detail }: { detail: LabRunDetail }) {
  const t = useTranslations("rateLab.run");
  const { carrierWins } = detail.insights;
  return (
    <Card title={t("winsTitle")} hint={t("winsHint")}>
      {carrierWins.length === 0 ? (
        <p>{t("noWins")}</p>
      ) : (
        <table className="table table-sm" aria-label={t("winsTitle")}>
          <thead>
            <tr>
              <th>{t("service")}</th>
              <th className="text-right">{t("wins")}</th>
            </tr>
          </thead>
          <tbody>
            {carrierWins.map((w) => (
              <tr key={w.serviceId}>
                <td>
                  {w.carrierName} {w.serviceName}
                </td>
                <td className="text-right tabular-nums">{w.wins}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function useProviderName() {
  const t = useTranslations();
  const tr = useTranslations("rateLab.run");
  return (provider: ShippingProviderId | null) =>
    provider ? t(`settings.shipping.names.${provider}`) : tr("noProvider");
}

export function FailuresCard({
  detail,
  nameOf,
}: {
  detail: LabRunDetail;
  nameOf: (key: string) => string;
}) {
  const t = useTranslations("rateLab.run");
  const message = useMessage();
  const providerName = useProviderName();
  const { failures } = detail.insights;
  return (
    <Card title={t("failuresTitle")}>
      {failures.length === 0 ? (
        <p>{t("noFailures")}</p>
      ) : (
        <ul className="space-y-3">
          {failures.map((f) => (
            <li key={f.provider ?? "none"}>
              <div className="font-semibold">
                {providerName(f.provider)}: {t("failureCount", { count: f.count })}
              </div>
              <ul className="list-disc ps-5 text-sm">
                {f.errors.map((e, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: errors have no id; the list never reorders.
                  <li key={i}>
                    {nameOf(e.combinationKey)}: {message(e.messageKey, e.params)}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

type RowStatus = "PURCHASABLE" | "QUOTE_ONLY" | "ERROR";
const rowStatuses: RowStatus[] = ["PURCHASABLE", "QUOTE_ONLY", "ERROR"];

/** Every quote and provider error, grouped by address × parcel, filtered by carrier, provider, status. */
export function QuoteTable({
  combinations,
  picks,
  filterable = true,
}: {
  combinations: LabCombination[];
  picks: Map<string, LabPick>;
  /** The report prints every row, so it has no filters. */
  filterable?: boolean;
}) {
  const t = useTranslations("rateLab.run");
  const format = useFormatter();
  const message = useMessage();
  const names = useCombinationName();
  const providerName = useProviderName();
  const [carrier, setCarrier] = useState(ALL);
  const [provider, setProvider] = useState(ALL);
  const [status, setStatus] = useState(ALL);

  const carriers = useMemo(() => {
    const found = new Map<string, string>();
    for (const q of combinations.flatMap((c) => c.quotes)) found.set(q.carrierId, q.carrierName);
    return [...found]
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [combinations]);
  const providers = useMemo(
    () => [
      ...new Set(
        combinations.flatMap((c) => [
          ...c.quotes.map((q) => q.provider),
          ...c.errors.flatMap((e) => (e.provider ? [e.provider] : [])),
        ]),
      ),
    ],
    [combinations],
  );

  const groups = combinations
    .map((c) => ({
      combination: c,
      quotes: c.quotes.filter(
        (q) =>
          (carrier === ALL || q.carrierId === carrier) &&
          (provider === ALL || q.provider === provider) &&
          (status === ALL || status === (q.quoteOnly ? "QUOTE_ONLY" : "PURCHASABLE")),
      ),
      errors: c.errors.filter(
        (e) =>
          carrier === ALL &&
          (provider === ALL || e.provider === provider) &&
          (status === ALL || status === "ERROR"),
      ),
    }))
    .filter((g) => g.quotes.length + g.errors.length > 0);
  const columns = 6;

  return (
    <section className="space-y-3">
      <h3 className="text-lg font-semibold">{t("quotesTitle")}</h3>
      {filterable && (
        <div className="flex flex-wrap gap-4">
          <div className="w-56">
            <SelectField
              label={t("carrier")}
              selectedKey={carrier}
              onSelectionChange={(v) => setCarrier(String(v))}
              options={[{ id: ALL, label: t("all") }, ...carriers]}
            />
          </div>
          <div className="w-56">
            <SelectField
              label={t("provider")}
              selectedKey={provider}
              onSelectionChange={(v) => setProvider(String(v))}
              options={[
                { id: ALL, label: t("all") },
                ...providers.map((p) => ({ id: p, label: providerName(p) })),
              ]}
            />
          </div>
          <div className="w-56">
            <SelectField
              label={t("status")}
              selectedKey={status}
              onSelectionChange={(v) => setStatus(String(v))}
              options={[
                { id: ALL, label: t("all") },
                ...rowStatuses.map((s) => ({ id: s, label: t(`row_${s}`) })),
              ]}
            />
          </div>
        </div>
      )}
      <div className="overflow-x-auto rounded-box bg-base-100 shadow-sm print:overflow-visible">
        <table className="table" aria-label={t("quotesTitle")}>
          <thead>
            <tr>
              <th>{t("provider")}</th>
              <th>{t("carrier")}</th>
              <th>{t("service")}</th>
              <th className="text-right">{t("price")}</th>
              <th className="text-right">{t("deliveryDays")}</th>
              <th>{t("marks")}</th>
            </tr>
          </thead>
          {groups.length === 0 && (
            <tbody>
              <tr>
                <td colSpan={columns}>{t("noRows")}</td>
              </tr>
            </tbody>
          )}
          {groups.map(({ combination: c, quotes, errors }) => {
            const pick = picks.get(c.key);
            return (
              <tbody key={c.key}>
                <tr className="bg-base-200">
                  <th colSpan={columns} scope="colgroup">
                    {names(c)}
                  </th>
                </tr>
                {quotes.map((q) => (
                  <tr key={q.id} data-testid="lab-quote-row">
                    <td>{providerName(q.provider)}</td>
                    <td>{q.carrierName}</td>
                    <td>{q.serviceName}</td>
                    <td className="text-right tabular-nums">{money(format, q.amountCents)}</td>
                    <td className="text-right tabular-nums">{q.deliveryDays ?? "—"}</td>
                    <td className="space-x-1">
                      {pick?.cheapestId === q.id && (
                        <span className="badge badge-success badge-sm">{t("cheapest")}</span>
                      )}
                      {pick?.fastestId === q.id && (
                        <span className="badge badge-info badge-sm">{t("fastest")}</span>
                      )}
                      {q.quoteOnly && (
                        <span className="badge badge-outline badge-sm">{t("quoteOnly")}</span>
                      )}
                    </td>
                  </tr>
                ))}
                {errors.map((e, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: errors have no id; the list never reorders.
                  <tr key={`error-${i}`} data-testid="lab-error-row">
                    <td>{providerName(e.provider)}</td>
                    <td colSpan={4} className="text-error">
                      {message(e.messageKey, e.params)}
                    </td>
                    <td>
                      <span className="badge badge-error badge-sm">{t("row_ERROR")}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            );
          })}
        </table>
      </div>
    </section>
  );
}
