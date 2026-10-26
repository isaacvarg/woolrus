"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import type { IssueRow, QualityIssueSeverity, QualityIssueType } from "@woolrus/contracts";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";
import { Input, Label, SearchField, Tab, TabList, Tabs } from "react-aria-components";
import { Button } from "@/components/ui/fields";
import { useErrorMessage } from "@/lib/errors";
import { orpc } from "@/lib/orpc";
import { IssueDrawer } from "./issue-drawer";

const SEARCH_DEBOUNCE_MS = 250;
const tabClass = ({ isSelected }: { isSelected: boolean }) =>
  `tab cursor-pointer outline-none ${isSelected ? "tab-active" : ""}`;

export type IssuesTab = "all" | "open" | "resolved";

const severities: QualityIssueSeverity[] = ["CRITICAL", "MAJOR", "MINOR"];
const types: QualityIssueType[] = [
  "WRONG_ITEM",
  "DAMAGED_ITEM",
  "MISSING_ITEM",
  "WRONG_QUANTITY",
  "PACKAGING_DAMAGE",
  "LABELING_ERROR",
  "WRONG_BOX_SIZE",
  "OTHER",
];

const severityBadge = {
  MINOR: "badge-ghost",
  MAJOR: "badge-warning",
  CRITICAL: "badge-error",
} as const;

/** The tab and the open issue live in `?tab=` and `?issue=`, so a reload or a link keeps them. */
export function IssuesManager({
  canResolve,
  canWriteCustomer,
  userId,
  initialTab,
  initialIssueId,
}: {
  canResolve: boolean;
  canWriteCustomer: boolean;
  userId: string | null;
  initialTab: IssuesTab;
  initialIssueId: string | null;
}) {
  const t = useTranslations();
  const format = useFormatter();
  const errorMessage = useErrorMessage();
  const ids = { severity: useId(), type: useId() };
  const [tab, setTab] = useState<IssuesTab>(initialTab);
  const [severity, setSeverity] = useState<QualityIssueSeverity | "">("");
  const [type, setType] = useState<QualityIssueType | "">("");
  const [typed, setTyped] = useState("");
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(initialIssueId);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(typed), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [typed]);

  const setParam = (name: string, value: string | null) => {
    const url = new URL(window.location.href);
    if (value) url.searchParams.set(name, value);
    else url.searchParams.delete(name);
    window.history.replaceState(null, "", url);
  };

  const list = useInfiniteQuery(
    orpc.issues.list.infiniteOptions({
      input: (cursor: string | undefined) => ({
        status: tab,
        severity: severity || undefined,
        type: type || undefined,
        search: search || undefined,
        cursor,
      }),
      initialPageParam: undefined,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
    }),
  );
  const rows = list.data?.pages.flatMap((p) => p.rows) ?? [];

  return (
    <div className="space-y-4">
      <Tabs
        selectedKey={tab}
        onSelectionChange={(key) => {
          setTab(key as IssuesTab);
          setParam("tab", key === "all" ? null : String(key));
        }}
      >
        <TabList className="tabs tabs-border" aria-label={t("issues.page.title")}>
          {(["all", "open", "resolved"] as const).map((id) => (
            <Tab key={id} id={id} className={tabClass}>
              {t(`issues.page.${id}`)}
            </Tab>
          ))}
        </TabList>
      </Tabs>

      <div className="flex flex-wrap items-end gap-3">
        <SearchField
          value={typed}
          onChange={setTyped}
          className="fieldset grow sm:max-w-sm"
          aria-label={t("issues.page.search")}
        >
          <Label className="sr-only">{t("issues.page.search")}</Label>
          <Input className="input w-full" placeholder={t("issues.page.search")} />
        </SearchField>
        {/* Native on purpose: tablets open their own large picker. */}
        <select
          id={ids.severity}
          aria-label={t("issues.page.severity")}
          className="select"
          value={severity}
          onChange={(event) => setSeverity(event.target.value as QualityIssueSeverity | "")}
        >
          <option value="">{t("issues.page.anySeverity")}</option>
          {severities.map((id) => (
            <option key={id} value={id}>
              {t(`issues.severities.${id}`)}
            </option>
          ))}
        </select>
        <select
          id={ids.type}
          aria-label={t("issues.page.type")}
          className="select"
          value={type}
          onChange={(event) => setType(event.target.value as QualityIssueType | "")}
        >
          <option value="">{t("issues.page.anyType")}</option>
          {types.map((id) => (
            <option key={id} value={id}>
              {t(`issues.types.${id}`)}
            </option>
          ))}
        </select>
      </div>

      {list.isPending && <p>{t("common.loading")}</p>}
      {list.error && <p className="text-error">{errorMessage(list.error)}</p>}
      {list.data && rows.length === 0 && <p>{t("issues.page.empty")}</p>}
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="table" aria-label={t("issues.page.title")}>
            <thead>
              <tr>
                <th>{t("issues.page.severity")}</th>
                <th>{t("issues.page.type")}</th>
                <th>{t("issues.page.order")}</th>
                <th>{t("issues.statusLabel")}</th>
                <th>{t("issues.responsibleLabel")}</th>
                <th>{t("issues.page.age")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <IssueTableRow
                  key={row.id}
                  row={row}
                  when={format.dateTime(row.createdAt, { dateStyle: "short", timeStyle: "short" })}
                  onOpen={() => {
                    setOpenId(row.id);
                    setParam("issue", row.id);
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.hasNextPage && (
        <Button
          className="btn-outline"
          isPending={list.isFetchingNextPage}
          onPress={() => void list.fetchNextPage()}
        >
          {t("issues.page.loadMore")}
        </Button>
      )}

      {openId && (
        <IssueDrawer
          issueId={openId}
          canResolve={canResolve}
          canWriteCustomer={canWriteCustomer}
          userId={userId}
          onClose={() => {
            setOpenId(null);
            setParam("issue", null);
          }}
        />
      )}
    </div>
  );
}

function IssueTableRow({ row, when, onOpen }: { row: IssueRow; when: string; onOpen: () => void }) {
  const t = useTranslations();
  const critical = row.severity === "CRITICAL" && row.status === "OPEN";
  return (
    <tr
      data-testid="issue-row"
      data-critical={critical || undefined}
      className={critical ? "bg-error/10" : undefined}
    >
      <td>
        <span className={`badge ${severityBadge[row.severity]}`}>
          {critical && <span aria-hidden="true">⚠ </span>}
          {t(`issues.severities.${row.severity}`)}
        </span>
      </td>
      <td>
        <Button className="btn-link p-0 text-left" onPress={onOpen}>
          {t(`issues.types.${row.type}`)}
        </Button>
        <div className="max-w-xs truncate text-xs text-base-content/60">{row.description}</div>
      </td>
      <td>
        <Link href={`/orders/${row.orderId}`} className="link">
          #{row.orderNumber}
        </Link>
        <div className="text-xs text-base-content/60">{row.customerName}</div>
      </td>
      <td>{t(`issues.statuses.${row.status}`)}</td>
      <td>{row.responsible?.name ?? "—"}</td>
      <td>{when}</td>
    </tr>
  );
}
