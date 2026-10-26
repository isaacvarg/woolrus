"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import type { VoidOrderGroup } from "@woolrus/contracts";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import {
  Checkbox as AriaCheckbox,
  Input,
  Label,
  SearchField,
  Tab,
  TabList,
  Tabs,
} from "react-aria-components";
import { Button } from "@/components/ui/fields";
import { useErrorMessage } from "@/lib/errors";
import { orpc } from "@/lib/orpc";
import { ResolveDialog } from "./resolve-dialog";

const SEARCH_DEBOUNCE_MS = 250;
const tabClass = ({ isSelected }: { isSelected: boolean }) =>
  `tab cursor-pointer outline-none ${isSelected ? "tab-active" : ""}`;

export type VoidsTab = "unresolved" | "resolved";

/** The tab lives in `?tab=`, so a reload or a link keeps it. */
export function VoidsManager({
  canResolve,
  initialTab,
}: {
  canResolve: boolean;
  initialTab: VoidsTab;
}) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const [tab, setTab] = useState<VoidsTab>(initialTab);
  const [typed, setTyped] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [resolving, setResolving] = useState<string[] | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(typed), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [typed]);

  const list = useInfiniteQuery(
    orpc.voids.list.infiniteOptions({
      input: (cursor: string | undefined) => ({ status: tab, search: search || undefined, cursor }),
      initialPageParam: undefined,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
    }),
  );
  const groups = list.data?.pages.flatMap((p) => p.groups) ?? [];
  // A void that got resolved or undone elsewhere drops out of the list, and out of the selection.
  const visible = new Set(groups.flatMap((g) => g.voids.map((v) => v.id)));
  const chosen = [...selected].filter((id) => visible.has(id));

  const toggle = (id: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <div className="space-y-4">
      <Tabs
        selectedKey={tab}
        onSelectionChange={(key) => {
          setTab(key as VoidsTab);
          setSelected(new Set());
          const url = new URL(window.location.href);
          if (key === "unresolved") url.searchParams.delete("tab");
          else url.searchParams.set("tab", String(key));
          window.history.replaceState(null, "", url);
        }}
      >
        <TabList className="tabs tabs-border" aria-label={t("voids.page.title")}>
          <Tab id="unresolved" className={tabClass}>
            {t("voids.page.unresolved")}
          </Tab>
          <Tab id="resolved" className={tabClass}>
            {t("voids.page.resolved")}
          </Tab>
        </TabList>
      </Tabs>

      <div className="flex flex-wrap items-end gap-3">
        <SearchField
          value={typed}
          onChange={setTyped}
          className="fieldset grow sm:max-w-sm"
          aria-label={t("voids.page.search")}
        >
          <Label className="sr-only">{t("voids.page.search")}</Label>
          <Input className="input w-full" placeholder={t("voids.page.search")} />
        </SearchField>
        {canResolve && tab === "unresolved" && (
          <Button isDisabled={chosen.length === 0} onPress={() => setResolving(chosen)}>
            {t("voids.page.resolveSelected", { count: chosen.length })}
          </Button>
        )}
      </div>

      {list.isPending && <p>{t("common.loading")}</p>}
      {list.error && <p className="text-error">{errorMessage(list.error)}</p>}
      {list.data && groups.length === 0 && <p>{t("voids.page.empty")}</p>}
      {groups.map((group) => (
        <OrderVoids
          key={group.order.id}
          group={group}
          canResolve={canResolve && tab === "unresolved"}
          showResolution={tab === "resolved"}
          selected={selected}
          onToggle={toggle}
          onResolveAll={() => setResolving(group.voids.map((v) => v.id))}
        />
      ))}
      {list.hasNextPage && (
        <Button
          className="btn-outline"
          isPending={list.isFetchingNextPage}
          onPress={() => void list.fetchNextPage()}
        >
          {t("voids.page.loadMore")}
        </Button>
      )}

      {resolving && (
        <ResolveDialog
          voidIds={resolving}
          onClose={() => setResolving(null)}
          onResolved={() => setSelected(new Set())}
        />
      )}
    </div>
  );
}

function OrderVoids({
  group,
  canResolve,
  showResolution,
  selected,
  onToggle,
  onResolveAll,
}: {
  group: VoidOrderGroup;
  canResolve: boolean;
  showResolution: boolean;
  selected: ReadonlySet<string>;
  onToggle: (id: string, on: boolean) => void;
  onResolveAll: () => void;
}) {
  const t = useTranslations();
  const format = useFormatter();
  const { order, voids } = group;

  return (
    <div className="card bg-base-100 shadow-sm" data-testid="void-order">
      <div className="card-body gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Link href={`/orders/${order.id}`} className="link text-lg font-semibold">
            #{order.number}
          </Link>
          <span className="grow text-base-content/70">{order.customerName}</span>
          <span className="badge badge-ghost">{t(`status.${order.status}`)}</span>
          {canResolve && (
            <Button className="btn-outline btn-sm" onPress={onResolveAll}>
              {t("voids.page.resolveOrder")}
            </Button>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="table" aria-label={`#${order.number}`}>
            <thead>
              <tr>
                {canResolve && <th className="w-12" />}
                <th>{t("voids.page.line")}</th>
                <th className="text-right">{t("voids.page.quantity")}</th>
                <th>{t("voids.page.reason")}</th>
                <th>{t("voids.page.stage")}</th>
                <th>{t("voids.page.who")}</th>
                <th>{t("voids.page.when")}</th>
              </tr>
            </thead>
            <tbody>
              {voids.map((v) => (
                <tr key={v.id}>
                  {canResolve && (
                    <td>
                      <AriaCheckbox
                        aria-label={t("voids.page.select", { name: v.lineName })}
                        isSelected={selected.has(v.id)}
                        onChange={(on) => onToggle(v.id, on)}
                        className="flex size-8 cursor-pointer items-center justify-center"
                      >
                        {({ isSelected }) => (
                          <span
                            aria-hidden="true"
                            className={`grid size-6 place-items-center rounded border-2 text-xs ${
                              isSelected
                                ? "border-primary bg-primary text-primary-content"
                                : "border-base-content/40"
                            }`}
                          >
                            {isSelected && "✓"}
                          </span>
                        )}
                      </AriaCheckbox>
                    </td>
                  )}
                  <td>
                    <div className="font-medium">{v.lineName}</div>
                    {v.sku && <div className="text-xs text-base-content/60">{v.sku}</div>}
                  </td>
                  <td className="text-right tabular-nums">{v.quantity}</td>
                  <td>
                    {v.reason}
                    {showResolution && v.resolution && (
                      <div className="text-xs text-base-content/70">
                        {t("voids.page.resolvedBy", {
                          outcome: t(`voids.page.outcomes.${v.resolution}`),
                          name: v.resolvedBy?.name ?? "—",
                        })}
                        {v.resolutionNotes && `: ${v.resolutionNotes}`}
                      </div>
                    )}
                  </td>
                  <td>{t(`voids.stage.${v.stage}`)}</td>
                  <td>{v.voidedBy?.name ?? "—"}</td>
                  <td>{format.dateTime(v.voidedAt, { dateStyle: "short", timeStyle: "short" })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
