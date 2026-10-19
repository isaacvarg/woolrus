"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SyncRunRow, SyncRunStatus, SyncTarget } from "@woolrus/contracts";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { Fragment, useState } from "react";
import { Button } from "@/components/ui/fields";
import { toast } from "@/components/ui/toast";
import { useErrorMessage } from "@/lib/errors";
import { orpc } from "@/lib/orpc";

/** While a run is going or was just queued, the log refreshes quickly; otherwise now and then. */
const ACTIVE_REFRESH_MS = 2_000;
const IDLE_REFRESH_MS = 15_000;
/** How long after a click to keep refreshing quickly, waiting for the worker to pick the job up. */
const QUEUED_WINDOW_MS = 30_000;

const statusBadge: Record<SyncRunStatus, string> = {
  RUNNING: "badge-info",
  SUCCEEDED: "badge-success",
  PARTIAL: "badge-warning",
  FAILED: "badge-error",
};

/** Message keys from the server, translated when known (an older key just shows as is). */
function useMessage() {
  const t = useTranslations();
  return (key: string) => (t.has(key) ? t(key as never) : key);
}

export function SyncRuns() {
  const t = useTranslations("sync");
  const format = useFormatter();
  const errorMessage = useErrorMessage();
  const message = useMessage();
  const queryClient = useQueryClient();
  const [queuedAt, setQueuedAt] = useState<number | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const status = useQuery(orpc.sync.status.queryOptions());
  const runs = useInfiniteQuery(
    orpc.sync.runs.infiniteOptions({
      input: (cursor: string | undefined) => ({ cursor }),
      initialPageParam: undefined,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
      refetchInterval: (query) => {
        const running = query.state.data?.pages.some((p) =>
          p.rows.some((r) => r.status === "RUNNING"),
        );
        const waiting = queuedAt !== null && Date.now() - queuedAt < QUEUED_WINDOW_MS;
        return running || waiting ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS;
      },
    }),
  );

  const run = useMutation(
    orpc.sync.run.mutationOptions({
      onSuccess: () => {
        setQueuedAt(Date.now());
        toast.success(t("page.queued"));
        return queryClient.invalidateQueries({ queryKey: orpc.sync.key() });
      },
      onError: (error) => toast.error(errorMessage(error)),
    }),
  );
  // One key per click: a retried request can't queue a second run.
  const request = (target: SyncTarget) =>
    run.mutate({ idempotencyKey: crypto.randomUUID(), target });

  const rows = runs.data?.pages.flatMap((p) => p.rows) ?? [];
  const lastWebhookAt = status.data?.lastWebhookAt;

  return (
    <div className="space-y-6">
      <div className="card bg-base-100 shadow-sm">
        <div className="card-body gap-4">
          <div className="flex flex-wrap gap-3">
            <Button isPending={run.isPending} onPress={() => request("orders")}>
              {t("page.syncOrders")}
            </Button>
            <Button
              className="btn-outline"
              isPending={run.isPending}
              onPress={() => request("products")}
            >
              {t("page.syncProducts")}
            </Button>
          </div>
          <p>
            <span className="font-semibold">{t("page.lastWebhook")}: </span>
            {lastWebhookAt
              ? format.dateTime(lastWebhookAt, { dateStyle: "medium", timeStyle: "medium" })
              : t("page.noWebhook")}
          </p>
        </div>
      </div>

      <h2 className="text-xl font-semibold">{t("page.runs")}</h2>
      <div className="overflow-x-auto rounded-box bg-base-100 shadow-sm">
        <table className="table" aria-label={t("page.runs")}>
          <thead>
            <tr>
              <th>{t("page.type")}</th>
              <th>{t("page.status")}</th>
              <th className="text-right">{t("page.processed")}</th>
              <th className="text-right">{t("page.failed")}</th>
              <th>{t("page.started")}</th>
              <th>{t("page.duration")}</th>
              <th>
                <span className="sr-only">{t("page.showErrors")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {runs.isPending && (
              <tr>
                <td colSpan={7}>{message("common.loading")}</td>
              </tr>
            )}
            {runs.error && (
              <tr>
                <td colSpan={7} className="text-error">
                  {errorMessage(runs.error)}
                </td>
              </tr>
            )}
            {runs.data && rows.length === 0 && (
              <tr>
                <td colSpan={7}>{message("common.empty")}</td>
              </tr>
            )}
            {rows.map((row) => {
              const expandable = row.failed > 0 || row.errorKey !== null;
              const expanded = open === row.id;
              return (
                <Fragment key={row.id}>
                  <tr>
                    <td>{t(`type.${row.type}`)}</td>
                    <td>
                      <span className={`badge ${statusBadge[row.status]}`}>
                        {t(`runStatus.${row.status}`)}
                      </span>
                    </td>
                    <td className="text-right tabular-nums">{row.processed}</td>
                    <td className="text-right tabular-nums">{row.failed}</td>
                    <td>
                      {format.dateTime(row.startedAt, { dateStyle: "short", timeStyle: "medium" })}
                    </td>
                    <td>{duration(row, format)}</td>
                    <td>
                      {expandable && (
                        <Button
                          className="btn-ghost btn-sm"
                          aria-expanded={expanded}
                          onPress={() => setOpen(expanded ? null : row.id)}
                        >
                          {expanded ? t("page.hideErrors") : t("page.showErrors")}
                        </Button>
                      )}
                    </td>
                  </tr>
                  {expanded && (
                    <tr>
                      <td colSpan={7} className="bg-base-200">
                        {row.errorKey && (
                          <p className="text-error">
                            {message(row.errorKey)}
                            {row.errorDetail && (
                              <code className="ml-2 text-xs">{row.errorDetail}</code>
                            )}
                          </p>
                        )}
                        <RunErrors runId={row.id} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {runs.hasNextPage && (
        <Button
          className="btn-outline"
          isPending={runs.isFetchingNextPage}
          onPress={() => void runs.fetchNextPage()}
        >
          {t("page.loadMore")}
        </Button>
      )}
    </div>
  );
}

function duration(row: SyncRunRow, format: ReturnType<typeof useFormatter>): string {
  if (!row.finishedAt) return "—";
  const seconds = (row.finishedAt.getTime() - row.startedAt.getTime()) / 1000;
  return seconds < 60
    ? format.number(seconds, { style: "unit", unit: "second", maximumFractionDigits: 1 })
    : format.number(seconds / 60, { style: "unit", unit: "minute", maximumFractionDigits: 1 });
}

/** A run's failed records; the WooCommerce id links to the order when it was imported. */
function RunErrors({ runId }: { runId: string }) {
  const t = useTranslations("sync.page");
  const message = useMessage();
  const errorMessage = useErrorMessage();
  const errors = useQuery(orpc.sync.runErrors.queryOptions({ input: { id: runId } }));

  if (errors.isPending) return <p>{message("common.loading")}</p>;
  if (errors.error) return <p className="text-error">{errorMessage(errors.error)}</p>;
  if (errors.data.length === 0) return <p>{t("noErrors")}</p>;
  return (
    <table className="table table-sm">
      <thead>
        <tr>
          <th>{t("record")}</th>
          <th>{t("error")}</th>
        </tr>
      </thead>
      <tbody>
        {errors.data.map((error) => (
          <tr key={error.id}>
            <td>
              {error.order ? (
                <Link className="link" href={`/orders/${error.order.id}`}>
                  {error.externalId} (#{error.order.number})
                </Link>
              ) : (
                error.externalId
              )}
            </td>
            <td>
              {message(error.messageKey)}
              {error.detail && <code className="ml-2 text-xs">{error.detail}</code>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
