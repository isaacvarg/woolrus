"use client";

import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { FailedJobRow } from "@woolrus/contracts";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/fields";
import { toast } from "@/components/ui/toast";
import { useErrorMessage } from "@/lib/errors";
import { orpc } from "@/lib/orpc";

const REFRESH_MS = 15_000;

export function FailedJobs() {
  const t = useTranslations("jobs");
  const format = useFormatter();
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const [queue, setQueue] = useState("");

  const jobs = useInfiniteQuery(
    orpc.operations.jobs.failed.list.infiniteOptions({
      input: (cursor: string | undefined) => ({ cursor, queue: queue || undefined }),
      initialPageParam: undefined,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
      refetchInterval: REFRESH_MS,
    }),
  );
  // The filter lists the queues seen so far, so the current one stays selectable.
  const [seen, setSeen] = useState<string[]>([]);
  const rows = jobs.data?.pages.flatMap((p) => p.rows) ?? [];
  const queues = [
    ...new Set([...seen, ...rows.map((r) => r.queue), ...(queue ? [queue] : [])]),
  ].sort();
  if (queues.length > seen.length) setSeen(queues);

  const done = (message: string) => ({
    onSuccess: () => {
      toast.success(message);
      return queryClient.invalidateQueries({ queryKey: orpc.operations.key() });
    },
    onError: (error: Error) => toast.error(errorMessage(error)),
  });
  const retry = useMutation(orpc.operations.jobs.failed.retry.mutationOptions(done(t("retried"))));
  const dismiss = useMutation(
    orpc.operations.jobs.failed.dismiss.mutationOptions(done(t("dismissed"))),
  );

  return (
    <div className="space-y-4">
      <label className="flex items-center gap-3">
        <span className="font-semibold">{t("queue")}</span>
        <select
          className="select select-bordered"
          value={queue}
          onChange={(event) => setQueue(event.target.value)}
        >
          <option value="">{t("allQueues")}</option>
          {queues.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>

      <div className="overflow-x-auto rounded-box bg-base-100 shadow-sm">
        <table className="table" aria-label={t("title")}>
          <thead>
            <tr>
              <th>{t("queue")}</th>
              <th>{t("failedAt")}</th>
              <th className="text-right">{t("attempts")}</th>
              <th>{t("error")}</th>
              <th>{t("about")}</th>
              <th>
                <span className="sr-only">{t("actions")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {jobs.isPending && (
              <tr>
                <td colSpan={6}>…</td>
              </tr>
            )}
            {jobs.error && (
              <tr>
                <td colSpan={6} className="text-error">
                  {errorMessage(jobs.error)}
                </td>
              </tr>
            )}
            {jobs.data && rows.length === 0 && (
              <tr>
                <td colSpan={6}>{t("empty")}</td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <code>{row.queue}</code>
                </td>
                <td>
                  {row.failedAt
                    ? format.dateTime(row.failedAt, { dateStyle: "short", timeStyle: "medium" })
                    : "—"}
                </td>
                <td className="text-right tabular-nums">{row.retryCount + 1}</td>
                <td className="max-w-xs break-words">{row.error ?? "—"}</td>
                <td>
                  <Summary summary={row.summary} />
                </td>
                <td className="whitespace-nowrap">
                  <Button
                    className="btn-sm"
                    aria-label={t("retryLabel", { queue: row.queue })}
                    isPending={retry.isPending && retry.variables?.id === row.id}
                    onPress={() => retry.mutate({ queue: row.queue, id: row.id })}
                  >
                    {t("retry")}
                  </Button>{" "}
                  <Button
                    className="btn-outline btn-sm"
                    aria-label={t("dismissLabel", { queue: row.queue })}
                    isPending={dismiss.isPending && dismiss.variables?.id === row.id}
                    onPress={() => dismiss.mutate({ queue: row.queue, id: row.id })}
                  >
                    {t("dismiss")}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {jobs.hasNextPage && (
        <Button
          className="btn-outline"
          isPending={jobs.isFetchingNextPage}
          onPress={() => void jobs.fetchNextPage()}
        >
          {t("loadMore")}
        </Button>
      )}
    </div>
  );
}

function Summary({ summary }: { summary: FailedJobRow["summary"] }) {
  const t = useTranslations("jobs");
  return (
    <>
      {summary.orderId && (
        <Link className="link" href={`/orders/${summary.orderId}`}>
          {t("order")}
        </Link>
      )}
      {summary.reason && <span className="ml-2">{summary.reason}</span>}
      {summary.template && <span>{t("template", { name: summary.template })}</span>}
    </>
  );
}
