"use client";

import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { LabRunRow, RateLabRunStatus } from "@woolrus/contracts";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/fields";
import { toast } from "@/components/ui/toast";
import { useErrorMessage, useMessage } from "@/lib/errors";
import { orpc } from "@/lib/orpc";
import { NewRunDialog } from "./new-run-dialog";

/** While a run is queued or going the list refreshes every 3 s (SPEC-rate-lab "UI"); otherwise now and then. */
const ACTIVE_REFRESH_MS = 3_000;
const IDLE_REFRESH_MS = 30_000;

export const statusBadge: Record<RateLabRunStatus, string> = {
  QUEUED: "badge-ghost",
  RUNNING: "badge-info",
  SUCCEEDED: "badge-success",
  PARTIAL: "badge-warning",
  FAILED: "badge-error",
  CANCELLED: "badge-neutral",
};

export const isActive = (row: LabRunRow) => row.status === "QUEUED" || row.status === "RUNNING";

export function RunsManager() {
  const t = useTranslations("rateLab.runs");
  const format = useFormatter();
  const errorMessage = useErrorMessage();
  const message = useMessage();
  const [starting, setStarting] = useState(false);

  const runs = useInfiniteQuery(
    orpc.rateLab.runs.infiniteOptions({
      input: (cursor: string | undefined) => ({ cursor }),
      initialPageParam: undefined,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
      refetchInterval: (query) =>
        query.state.data?.pages.some((p) => p.rows.some(isActive))
          ? ACTIVE_REFRESH_MS
          : IDLE_REFRESH_MS,
    }),
  );
  const rows = runs.data?.pages.flatMap((p) => p.rows) ?? [];
  const columns = 8;

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onPress={() => setStarting(true)}>{t("newRun")}</Button>
      </div>
      <div className="overflow-x-auto rounded-box bg-base-100 shadow-sm">
        <table className="table" aria-label={t("title")}>
          <thead>
            <tr>
              <th>{t("startedAt")}</th>
              <th>{t("startedBy")}</th>
              <th>{t("duration")}</th>
              <th>{t("status")}</th>
              <th className="text-right">{t("combinations")}</th>
              <th className="text-right">{t("quotes")}</th>
              <th className="text-right">{t("failures")}</th>
              <th>{t("groups")}</th>
            </tr>
          </thead>
          <tbody>
            {runs.isPending && (
              <tr>
                <td colSpan={columns}>{message("common.loading")}</td>
              </tr>
            )}
            {runs.error && (
              <tr>
                <td colSpan={columns} className="text-error">
                  {errorMessage(runs.error)}
                </td>
              </tr>
            )}
            {runs.data && rows.length === 0 && (
              <tr>
                <td colSpan={columns}>{t("empty")}</td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={row.id} data-testid="lab-run-row">
                <td>
                  <Link href={`/rate-lab/runs/${row.id}`} className="link link-hover">
                    {format.dateTime(row.startedAt ?? row.createdAt, {
                      dateStyle: "short",
                      timeStyle: "medium",
                    })}
                  </Link>
                </td>
                <td>{row.startedBy?.name ?? "—"}</td>
                <td>{duration(row, format)}</td>
                <td>
                  <span className={`badge ${statusBadge[row.status]}`}>
                    {t(`status_${row.status}`)}
                  </span>
                  {row.fake && <span className="badge badge-outline ms-1">{t("fake")}</span>}
                  {row.error && <div className="text-sm text-error">{message(row.error)}</div>}
                  {isActive(row) && <CancelRun row={row} />}
                </td>
                <td className="text-right tabular-nums">
                  {row.status === "RUNNING" ? (
                    <div className="space-y-1">
                      <div>
                        {t("progress", {
                          done: row.completedCombinations,
                          total: row.combinations,
                        })}
                      </div>
                      <progress
                        className="progress progress-info w-24"
                        value={row.completedCombinations}
                        max={Math.max(row.combinations, 1)}
                        aria-label={t("progressLabel")}
                      />
                    </div>
                  ) : (
                    row.combinations
                  )}
                </td>
                <td className="text-right tabular-nums">{row.quoteCount}</td>
                <td className="text-right tabular-nums">{row.failureCount}</td>
                <td className="text-sm">
                  <Side label={t("addresses")} all={t("allAddresses")} side={row.addresses} />
                  <Side label={t("parcels")} all={t("allParcels")} side={row.parcels} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {runs.hasNextPage && (
        <Button
          className="btn-outline"
          isPending={runs.isFetchingNextPage}
          onPress={() => void runs.fetchNextPage()}
        >
          {t("loadMore")}
        </Button>
      )}
      {starting && <NewRunDialog onClose={() => setStarting(false)} />}
    </div>
  );
}

/** Cancel for a queued or running run; once asked, a running run says it's stopping. */
function CancelRun({ row }: { row: LabRunRow }) {
  const t = useTranslations("rateLab.runs");
  const format = useFormatter();
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const cancel = useMutation(
    orpc.rateLab.cancelRun.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: orpc.rateLab.runs.key() });
        toast.success(t("cancelled"));
      },
      onError: (error) => toast.error(errorMessage(error)),
    }),
  );
  if (row.cancelRequested) {
    return <div className="text-sm opacity-70">{t("cancelAsked")}</div>;
  }
  return (
    <Button
      className="btn-outline btn-error btn-xs mt-1 block"
      aria-label={t("cancelRunLabel", {
        startedAt: format.dateTime(row.startedAt ?? row.createdAt, {
          dateStyle: "short",
          timeStyle: "medium",
        }),
      })}
      isPending={cancel.isPending}
      onPress={() => cancel.mutate({ id: row.id })}
    >
      {t("cancelRun")}
    </Button>
  );
}

/** One side of the selection: its groups and how many items were picked, or "All …". */
export function Side({
  label,
  all,
  side,
}: {
  label: string;
  all: string;
  side: LabRunRow["addresses"];
}) {
  const t = useTranslations("rateLab.runs");
  if (side.groups.length === 0 && side.items === 0) return <div>{all}</div>;
  return (
    <div>
      <span className="opacity-70">{label}: </span>
      {[
        ...side.groups.map((g) => g.name),
        ...(side.items > 0 ? [t("picked", { count: side.items })] : []),
      ].join(", ")}
    </div>
  );
}

export function duration(row: LabRunRow, format: ReturnType<typeof useFormatter>): string {
  if (!row.startedAt || !row.finishedAt) return "—";
  const seconds = (row.finishedAt.getTime() - row.startedAt.getTime()) / 1000;
  return seconds < 60
    ? format.number(seconds, { style: "unit", unit: "second", maximumFractionDigits: 1 })
    : format.number(seconds / 60, { style: "unit", unit: "minute", maximumFractionDigits: 1 });
}
