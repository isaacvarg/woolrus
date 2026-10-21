"use client";

import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { QueueRow, QueueStage } from "@woolrus/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Input, Label, SearchField } from "react-aria-components";
import { NoteCount } from "@/components/notes/note-count";
import { Button, Checkbox } from "@/components/ui/fields";
import { toast } from "@/components/ui/toast";
import { useErrorMessage } from "@/lib/errors";
import { orpc } from "@/lib/orpc";
import { useReasonText } from "@/lib/reasons";
import { PickTogether } from "./pick-together";

const SEARCH_DEBOUNCE_MS = 250;

/** Time in stage, coarsened for a glance: minutes, then hours, then days. */
function ageParts(since: Date, now: number): { unit: "Minutes" | "Hours" | "Days"; count: number } {
  const minutes = Math.max(0, Math.floor((now - since.getTime()) / 60_000));
  if (minutes < 60) return { unit: "Minutes", count: minutes };
  if (minutes < 24 * 60) return { unit: "Hours", count: Math.floor(minutes / 60) };
  return { unit: "Days", count: Math.floor(minutes / (24 * 60)) };
}

const priorityBadge: Record<number, string> = { 1: "badge-warning", 2: "badge-error" };

export function QueueTable({
  stage,
  userId,
  canBeginPicking,
}: {
  stage: QueueStage;
  userId: string | null;
  canBeginPicking: boolean;
}) {
  const t = useTranslations();
  const reasonText = useReasonText();
  const format = useFormatter();
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const [searchText, setSearchText] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchText.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchText]);

  const queue = useInfiniteQuery(
    orpc.orders.queue.infiniteOptions({
      input: (cursor: string | undefined) => ({ stage, search: search || undefined, cursor }),
      initialPageParam: undefined,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
    }),
  );
  const rows = queue.data?.pages.flatMap((page) => page.rows) ?? [];
  const now = Date.now();
  const onHold = stage === "ON_HOLD";
  const showBeginPicking = stage === "PENDING" && canBeginPicking;
  const columns = 7 + (onHold ? 1 : 0) + (showBeginPicking ? 2 : 0);
  // Ticked for Pick together, by id. Rows keep the version they were ticked at: if one changes
  // meanwhile the batch is refused as stale and the panel says so.
  const [selected, setSelected] = useState<Map<string, QueueRow>>(() => new Map());
  const toggle = (row: QueueRow, on: boolean) =>
    setSelected((current) => {
      const next = new Map(current);
      if (on) next.set(row.id, row);
      else next.delete(row.id);
      return next;
    });

  const beginPicking = useMutation(
    orpc.orders.beginPicking.mutationOptions({
      onSuccess: (order) => {
        toast.success(t("queue.begunPicking", { number: order.number }));
        router.push(`/pick/${order.id}`);
      },
      onError: (error) => toast.error(errorMessage(error)),
      // A stale version means another station moved it: refetch either way so the row is current.
      onSettled: () => queryClient.invalidateQueries({ queryKey: orpc.orders.key() }),
    }),
  );

  const claimedByOther = (row: QueueRow) => row.claim !== null && row.claim.userId !== userId;

  return (
    <div className="space-y-4">
      <SearchField
        value={searchText}
        onChange={setSearchText}
        className="fieldset max-w-md"
        aria-label={t("queue.search")}
      >
        <Label className="sr-only">{t("queue.search")}</Label>
        <Input className="input input-lg w-full" placeholder={t("queue.searchPlaceholder")} />
      </SearchField>

      {showBeginPicking && (
        <PickTogether selected={[...selected.values()]} onStarted={() => setSelected(new Map())} />
      )}

      <div className="overflow-x-auto rounded-box bg-base-100 shadow-sm">
        <table className="table text-base">
          <thead>
            <tr>
              {showBeginPicking && (
                <th>
                  <span className="sr-only">{t("queue.select")}</span>
                </th>
              )}
              <th>{t("queue.number")}</th>
              <th>{t("queue.customer")}</th>
              <th className="text-end">{t("queue.items")}</th>
              <th>{t("queue.priority")}</th>
              {/* Hidden on tablets in portrait: the floor needs the age, not the date. */}
              <th className="hidden lg:table-cell">{t("queue.orderedAt")}</th>
              <th>{t("queue.age")}</th>
              {onHold ? (
                <>
                  <th>{t("queue.heldFrom")}</th>
                  <th>{t("queue.holdReason")}</th>
                </>
              ) : (
                <th>{t("queue.claimedBy")}</th>
              )}
              {showBeginPicking && (
                <th>
                  <span className="sr-only">{t("queue.beginPicking")}</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {queue.isPending && (
              <tr>
                <td colSpan={columns}>{t("common.loading")}</td>
              </tr>
            )}
            {queue.error && (
              <tr>
                <td colSpan={columns} className="text-error">
                  {errorMessage(queue.error)}
                </td>
              </tr>
            )}
            {queue.isSuccess && rows.length === 0 && (
              <tr>
                <td colSpan={columns}>{t("queue.noOrders")}</td>
              </tr>
            )}
            {rows.map((row) => {
              const age = ageParts(row.stageEnteredAt, now);
              const href = `/orders/${row.id}` as const;
              return (
                <tr
                  key={row.id}
                  className="h-16 cursor-pointer hover:bg-base-200"
                  // The whole row is a tap target on tablets; the number link is the accessible one.
                  onClick={(event) => {
                    if (!(event.target as HTMLElement).closest("a, button, label"))
                      router.push(href);
                  }}
                >
                  {showBeginPicking && (
                    <td className="w-12">
                      {!claimedByOther(row) && (
                        <Checkbox
                          aria-label={t("queue.selectOrder", { number: row.number })}
                          isSelected={selected.has(row.id)}
                          onChange={(on) => toggle(row, on)}
                        >
                          {null}
                        </Checkbox>
                      )}
                    </td>
                  )}
                  <td className="font-semibold whitespace-nowrap">
                    <Link href={href} className="link link-hover">
                      #{row.number}
                    </Link>
                    {row.externalChange && (
                      <span
                        role="img"
                        aria-label={t("queue.externalChange")}
                        title={t("queue.externalChange")}
                        className="ms-2 text-warning"
                      >
                        ⚠
                      </span>
                    )}
                    <NoteCount count={row.noteCount} className="ms-2" />
                  </td>
                  <td>{row.customerName}</td>
                  <td className="text-end tabular-nums">{row.itemCount}</td>
                  <td>
                    {row.priority > 0 && (
                      <span className={`badge ${priorityBadge[row.priority] ?? "badge-error"}`}>
                        {t(`queue.priorityLevel.${Math.min(row.priority, 2) as 1 | 2}`)}
                      </span>
                    )}
                  </td>
                  <td className="hidden whitespace-nowrap lg:table-cell">
                    {format.dateTime(row.orderedAt, { dateStyle: "short", timeStyle: "short" })}
                  </td>
                  <td
                    className={`whitespace-nowrap ${row.slaBreached ? "font-semibold text-error" : ""}`}
                    title={row.slaBreached ? t("queue.slaBreached") : undefined}
                  >
                    {t(`queue.age${age.unit}`, { count: age.count })}
                    {/* Red alone and a hover title reach neither screen readers nor touch. */}
                    {row.slaBreached && <span className="sr-only"> {t("queue.slaBreached")}</span>}
                  </td>
                  {onHold ? (
                    <>
                      <td>{row.heldFromStatus && t(`status.${row.heldFromStatus}`)}</td>
                      <td>{row.holdReason && reasonText(row.holdReason)}</td>
                    </>
                  ) : (
                    <td>{row.claim?.userName}</td>
                  )}
                  {showBeginPicking && (
                    <td className="text-end">
                      {!claimedByOther(row) && (
                        <Button
                          isPending={
                            beginPicking.isPending && beginPicking.variables?.id === row.id
                          }
                          onPress={() =>
                            beginPicking.mutate({ id: row.id, expectedVersion: row.version })
                          }
                        >
                          {t("queue.beginPicking")}
                        </Button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {queue.hasNextPage && (
        <Button
          className="btn-outline"
          isPending={queue.isFetchingNextPage}
          onPress={() => queue.fetchNextPage()}
        >
          {t("queue.loadMore")}
        </Button>
      )}
    </div>
  );
}
