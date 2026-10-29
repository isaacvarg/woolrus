"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  createColumnHelper,
  rowPaginationFeature,
  rowSortingFeature,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import {
  OrderListInput,
  type OrderListRow,
  type OrderListSort,
  WorkflowStatus,
} from "@woolrus/contracts";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Input, Label, SearchField, ToggleButton, ToggleButtonGroup } from "react-aria-components";
import type { z } from "zod";
import { NoteCount } from "@/components/notes/note-count";
import { Button } from "@/components/ui/fields";
import { useErrorMessage } from "@/lib/errors";
import { orpc } from "@/lib/orpc";

const SEARCH_DEBOUNCE_MS = 250;

type Query = z.output<typeof OrderListInput>;
const defaults: Query = OrderListInput.parse({});

/** The view as the URL query has it. A bad value falls back to its default, keeping the rest. */
function readQuery(params: URLSearchParams): Query {
  const field = <K extends keyof Query>(key: K, value: unknown): Query[K] => {
    const parsed = OrderListInput.shape[key].safeParse(value);
    return parsed.success ? (parsed.data as Query[K]) : defaults[key];
  };
  const statuses = params.getAll("statuses");
  return {
    search: field("search", params.get("search") || undefined),
    statuses: field("statuses", statuses.length ? statuses : undefined),
    sort: field("sort", params.get("sort") ?? undefined),
    dir: field("dir", params.get("dir") ?? undefined),
    page: field("page", params.get("page") ?? undefined),
    pageSize: field("pageSize", params.get("pageSize") ?? undefined),
  };
}

/** Only what differs from the defaults goes in the URL, so the plain `/orders` link is the default view. */
function toSearch(query: Query): string {
  const params = new URLSearchParams();
  if (query.search) params.set("search", query.search);
  for (const status of query.statuses ?? []) params.append("statuses", status);
  if (query.sort !== defaults.sort || query.dir !== defaults.dir) {
    params.set("sort", query.sort);
    params.set("dir", query.dir);
  }
  if (query.page !== defaults.page) params.set("page", String(query.page));
  if (query.pageSize !== defaults.pageSize) params.set("pageSize", String(query.pageSize));
  const search = params.toString();
  return search ? `?${search}` : "";
}

const features = tableFeatures({ rowSortingFeature, rowPaginationFeature });
const column = createColumnHelper<typeof features, OrderListRow>();
const priorityBadge: Record<number, string> = { 1: "badge-warning", 2: "badge-error" };

// Column ids are the API's sort keys. Text sorts A→Z first; dates and priority newest/highest first.
const columns = column.columns([
  column.accessor("number", { id: "number", sortDescFirst: false }),
  column.accessor("customerName", { id: "customer", sortDescFirst: false }),
  column.accessor("status", { id: "status", sortDescFirst: false }),
  column.accessor("priority", { id: "priority", sortDescFirst: true }),
  column.accessor("orderedAt", { id: "orderedAt", sortDescFirst: true }),
]);

const headerKey = {
  number: "queue.number",
  customer: "queue.customer",
  status: "orders.status",
  priority: "queue.priority",
  orderedAt: "queue.orderedAt",
} as const satisfies Record<OrderListSort, string>;

export function OrdersTable() {
  const t = useTranslations();
  const format = useFormatter();
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const query = readQuery(useSearchParams());

  // Next keeps useSearchParams in step with the History API, without a server round trip.
  const navigate = (next: Partial<Query>, { replace = false } = {}) => {
    const url = `/orders${toSearch({ ...query, ...next })}`;
    if (replace) window.history.replaceState(null, "", url);
    else window.history.pushState(null, "", url);
  };

  const [searchText, setSearchText] = useState(query.search ?? "");
  // Back/Forward can change the search under the box: follow it, unless it's what's being typed.
  const [urlSearch, setUrlSearch] = useState(query.search);
  if (query.search !== urlSearch) {
    setUrlSearch(query.search);
    if ((searchText.trim() || undefined) !== query.search) setSearchText(query.search ?? "");
  }
  useEffect(() => {
    const timer = setTimeout(() => {
      const search = searchText.trim() || undefined;
      // Typing replaces the entry: Back shouldn't step through every keystroke.
      if (search !== query.search) navigate({ search, page: 1 }, { replace: true });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  });

  const list = useQuery(
    orpc.orders.list.queryOptions({ input: query, placeholderData: keepPreviousData }),
  );

  const table = useTable({
    features,
    columns,
    data: list.data?.rows ?? [],
    getRowId: (row) => row.id,
    manualSorting: true,
    manualPagination: true,
    enableSortingRemoval: false,
    enableMultiSort: false,
    rowCount: list.data?.total ?? 0,
    state: {
      sorting: [{ id: query.sort, desc: query.dir === "desc" }],
      pagination: { pageIndex: query.page - 1, pageSize: query.pageSize },
    },
    onSortingChange: (updater) => {
      const current = [{ id: query.sort, desc: query.dir === "desc" }];
      const [next] = typeof updater === "function" ? updater(current) : updater;
      if (next)
        navigate({ sort: next.id as OrderListSort, dir: next.desc ? "desc" : "asc", page: 1 });
    },
    onPaginationChange: (updater) => {
      const current = { pageIndex: query.page - 1, pageSize: query.pageSize };
      const next = typeof updater === "function" ? updater(current) : updater;
      navigate({ page: next.pageIndex + 1, pageSize: next.pageSize });
    },
  });

  const rows = table.getRowModel().rows;
  const pageCount = Math.max(1, table.getPageCount());

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-4">
        <SearchField
          value={searchText}
          onChange={setSearchText}
          className="fieldset w-full max-w-md"
          aria-label={t("queue.search")}
        >
          <Label className="sr-only">{t("queue.search")}</Label>
          <Input
            className="input input-lg w-full"
            placeholder={t("queue.searchPlaceholder")}
            // The API rejects longer searches.
            maxLength={100}
          />
        </SearchField>
        <ToggleButtonGroup
          aria-label={t("orders.statusFilter")}
          selectionMode="multiple"
          selectedKeys={query.statuses ?? []}
          onSelectionChange={(keys) => {
            const statuses = WorkflowStatus.options.filter((status) => keys.has(status));
            navigate({ statuses: statuses.length ? statuses : undefined, page: 1 });
          }}
          className="flex flex-wrap gap-2"
        >
          {WorkflowStatus.options.map((status) => (
            <ToggleButton
              key={status}
              id={status}
              className={({ isSelected }) =>
                `btn btn-sm ${isSelected ? "btn-primary" : "btn-outline"}`
              }
            >
              {t(`status.${status}`)}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      </div>

      <div className="overflow-x-auto rounded-box bg-base-100 shadow-sm">
        <table className="table text-base">
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => {
                  const sorted = header.column.getIsSorted();
                  return (
                    <th
                      key={header.id}
                      aria-sort={
                        sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"
                      }
                    >
                      <Button
                        className="btn-ghost btn-sm -ms-3 gap-1 font-semibold"
                        onPress={() => header.column.toggleSorting()}
                      >
                        {t(headerKey[header.column.id as OrderListSort])}
                        <span aria-hidden="true" className="w-3">
                          {sorted === "asc" ? "▲" : sorted === "desc" ? "▼" : ""}
                        </span>
                      </Button>
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {list.isPending && (
              <tr>
                <td colSpan={columns.length}>{t("common.loading")}</td>
              </tr>
            )}
            {list.error && (
              <tr>
                <td colSpan={columns.length} className="text-error">
                  {errorMessage(list.error)}
                </td>
              </tr>
            )}
            {list.isSuccess && rows.length === 0 && (
              <tr>
                <td colSpan={columns.length}>{t("orders.noOrders")}</td>
              </tr>
            )}
            {rows.map(({ original: row }) => {
              const href = `/orders/${row.id}` as const;
              return (
                <tr
                  key={row.id}
                  className="h-16 cursor-pointer hover:bg-base-200"
                  // The whole row is a tap target on tablets; the number link is the accessible one.
                  onClick={(event) => {
                    if (!(event.target as HTMLElement).closest("a, button")) router.push(href);
                  }}
                >
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
                  <td>
                    {row.piiRedacted ? (
                      <span className="italic opacity-70">{t("order.customerRemoved")}</span>
                    ) : (
                      row.customerName
                    )}
                  </td>
                  <td>{t(`status.${row.status}`)}</td>
                  <td>
                    {row.priority > 0 && (
                      <span className={`badge ${priorityBadge[row.priority] ?? "badge-error"}`}>
                        {t(`queue.priorityLevel.${Math.min(row.priority, 2) as 1 | 2}`)}
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap">
                    {format.dateTime(row.orderedAt, { dateStyle: "short", timeStyle: "short" })}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <nav aria-label={t("orders.pagination")} className="flex flex-wrap items-center gap-4">
        <Button
          className="btn-outline"
          isDisabled={!table.getCanPreviousPage()}
          onPress={() => table.previousPage()}
        >
          {t("orders.previousPage")}
        </Button>
        <span className="tabular-nums">
          {t("orders.pageOf", { page: query.page, pages: pageCount })}
        </span>
        <Button
          className="btn-outline"
          isDisabled={!table.getCanNextPage()}
          onPress={() => table.nextPage()}
        >
          {t("orders.nextPage")}
        </Button>
        {list.data && (
          <span className="text-base-content/70">
            {t("orders.total", { count: list.data.total })}
          </span>
        )}
      </nav>
    </div>
  );
}
