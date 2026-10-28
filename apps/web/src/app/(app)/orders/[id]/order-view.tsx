"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ItemVoidView, OrderView as Order } from "@woolrus/contracts";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { IssueCard } from "@/components/exceptions/issue-card";
import {
  ReportIssueDialog,
  type ReportIssueDialogInput,
} from "@/components/exceptions/report-issue-dialog";
import { VoidDialog } from "@/components/exceptions/void-dialog";
import { VoidRow } from "@/components/exceptions/void-row";
import type { TargetOption } from "@/components/notes/note-composer";
import { useTargetName } from "@/components/notes/note-list";
import { NoteOnTarget, NotesPanel } from "@/components/notes/notes-panel";
import { OrderShippingPanel } from "@/components/shipping/order-shipping";
import { Button } from "@/components/ui/fields";
import { toast } from "@/components/ui/toast";
import { useErrorMessage } from "@/lib/errors";
import { client, orpc } from "@/lib/orpc";
import { formatAddress } from "./address";
import { ExternalChangeBanner } from "./external-change-banner";
import { HistoryPanel } from "./history-panel";
import { OrderActions } from "./order-actions";

const priorityBadge: Record<number, string> = { 1: "badge-warning", 2: "badge-error" };

type NoteTargets = {
  all: TargetOption[];
  line: (id: string) => TargetOption;
  pkg: (id: string) => TargetOption;
};

/** What a note on this order can be on, worded as the notes list words it. */
function useNoteTargets(order: Order): NoteTargets {
  const targetName = useTargetName();
  const lines = order.lines.map((line) => ({
    target: { kind: "item" as const, id: line.id },
    label: targetName({ kind: "item", label: `${line.name} ×${line.quantity}` }),
  }));
  const packages = order.packages.map((pkg) => ({
    target: { kind: "package" as const, id: pkg.id },
    label: targetName({ kind: "package", label: String(pkg.number) }),
  }));
  const all = [
    {
      target: { kind: "order" as const },
      label: targetName({ kind: "order", label: order.number }),
    },
    ...lines,
    ...packages,
  ];
  const find = (options: TargetOption[], id: string) =>
    options.find((o) => o.target.kind !== "order" && o.target.id === id) as TargetOption;
  return { all, line: (id) => find(lines, id), pkg: (id) => find(packages, id) };
}

export function OrderView({
  id,
  userId,
  canWriteCustomer,
  canVoid,
  canReport,
  canRefreshRates,
}: {
  id: string;
  userId: string | null;
  canWriteCustomer: boolean;
  canVoid: boolean;
  canReport: boolean;
  canRefreshRates: boolean;
}) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const order = useQuery(orpc.orders.get.queryOptions({ input: { id } }));

  if (order.isPending) return <p>{t("common.loading")}</p>;
  if (order.error) {
    return (
      <p role="alert" className="alert alert-error">
        {errorMessage(order.error)}
      </p>
    );
  }
  return (
    <OrderLayout
      order={order.data}
      userId={userId}
      canWriteCustomer={canWriteCustomer}
      canVoid={canVoid}
      canReport={canReport}
      canRefreshRates={canRefreshRates}
    />
  );
}

function OrderLayout({
  order,
  userId,
  canWriteCustomer,
  canVoid,
  canReport,
  canRefreshRates,
}: {
  order: Order;
  userId: string | null;
  canWriteCustomer: boolean;
  canVoid: boolean;
  canReport: boolean;
  canRefreshRates: boolean;
}) {
  const t = useTranslations();
  const targets = useNoteTargets(order);
  const notes = { orderId: order.id, canWriteCustomer, targets };
  return (
    <section className="mx-auto max-w-6xl space-y-6">
      <OrderHeader order={order} />
      <ExternalChangeBanner order={order} />
      {order.status === "PICKING" && (
        <Link href={`/pick/${order.id}`} className="btn btn-secondary btn-lg">
          {t("order.openPickScreen")}
        </Link>
      )}
      {order.status === "PACKING" && (
        <Link href={`/pack/${order.id}`} className="btn btn-secondary btn-lg">
          {t("order.openPackScreen")}
        </Link>
      )}
      <OrderActions order={order} userId={userId} />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <OrderLines order={order} notes={notes} canVoid={canVoid} />
          <OrderPackages order={order} notes={notes} />
          {order.packages.length > 0 && (
            <OrderShippingPanel orderId={order.id} canRefresh={canRefreshRates} />
          )}
          <ExceptionsPanel
            order={order}
            canReport={canReport}
            canWriteCustomer={canWriteCustomer}
          />
          <NotesPanel
            orderId={order.id}
            canWriteCustomer={canWriteCustomer}
            targets={targets.all}
          />
        </div>
        <HistoryPanel id={order.id} />
      </div>
    </section>
  );
}

function OrderHeader({ order }: { order: Order }) {
  const t = useTranslations();
  const format = useFormatter();
  const level = Math.min(order.priority, 2) as 0 | 1 | 2;

  return (
    <header className="space-y-4">
      <h1 className="text-3xl font-bold">
        {t("order.title", { number: order.number })}
        {order.externalChange && (
          <span
            role="img"
            aria-label={t("queue.externalChange")}
            title={t("queue.externalChange")}
            className="ms-3 text-warning"
          >
            ⚠
          </span>
        )}
      </h1>
      <dl className="grid grid-cols-2 gap-4 rounded-box bg-base-100 p-4 shadow-sm md:grid-cols-4">
        <div>
          <dt className="text-sm opacity-70">{t("order.status")}</dt>
          <dd>
            <span className="badge badge-lg badge-primary" data-testid="order-status">
              {t(`status.${order.status}`)}
            </span>
          </dd>
        </div>
        <div>
          <dt className="text-sm opacity-70">{t("order.priority")}</dt>
          <dd>
            <span className={`badge badge-lg ${priorityBadge[level] ?? "badge-ghost"}`}>
              {t(`queue.priorityLevel.${level}`)}
            </span>
          </dd>
        </div>
        <div>
          <dt className="text-sm opacity-70">{t("order.customer")}</dt>
          <dd className="font-semibold">{order.customerName}</dd>
          {order.customerEmail && <dd className="text-sm break-all">{order.customerEmail}</dd>}
        </div>
        <div>
          <dt className="text-sm opacity-70">{t("order.orderedAt")}</dt>
          <dd>{format.dateTime(order.orderedAt, { dateStyle: "medium", timeStyle: "short" })}</dd>
        </div>
        <div>
          <dt className="text-sm opacity-70">{t("order.shippingMethod")}</dt>
          <dd>{order.shippingMethod ?? "—"}</dd>
        </div>
        <div className="col-span-2 md:col-span-3">
          <dt className="text-sm opacity-70">{t("order.shipTo")}</dt>
          <dd>{formatAddress(order.shippingAddress)}</dd>
        </div>
        {order.customerNote && (
          <div className="col-span-2 md:col-span-4">
            <dt className="text-sm opacity-70">{t("order.customerNote")}</dt>
            <dd className="whitespace-pre-line">{order.customerNote}</dd>
          </div>
        )}
      </dl>
    </header>
  );
}

type NotesProps = { orderId: string; canWriteCustomer: boolean; targets: NoteTargets };

/** Whether a void or an undo can still change this order; the server checks it again. */
function isVoidable(order: Order): boolean {
  return (
    order.status !== "COMPLETED" &&
    order.status !== "CANCELLED" &&
    !order.packages.some((p) => p.liveLabel)
  );
}

function OrderLines({
  order,
  notes,
  canVoid,
}: {
  order: Order;
  notes: NotesProps;
  canVoid: boolean;
}) {
  const t = useTranslations();
  const format = useFormatter();
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const [voidingId, setVoidingId] = useState<string | null>(null);
  const voiding = order.lines.find((l) => l.id === voidingId);
  const mayVoid = canVoid && isVoidable(order);

  // The pick and pack screens show the same lines, so they refetch too.
  const refresh = () =>
    Promise.all(
      [orpc.orders.key(), orpc.picking.key(), orpc.packing.key()].map((queryKey) =>
        queryClient.invalidateQueries({ queryKey }),
      ),
    );
  const voidMutation = useMutation({
    mutationFn: (input: { orderItemId: string; quantity: number; reason: string }) =>
      client.voids.void({ orderId: order.id, ...input }),
    onSuccess: (result, input) => {
      const name = order.lines.find((l) => l.id === input.orderItemId)?.name ?? "";
      toast.success(t("voids.done", { count: input.quantity, name }));
      return result;
    },
    onError: (error) => toast.error(errorMessage(error)),
    onSettled: refresh,
  });
  const undoMutation = useMutation({
    mutationFn: (voided: ItemVoidView) => client.voids.undo({ voidId: voided.id }),
    onSuccess: () => toast.success(t("voids.undone")),
    onError: (error) => toast.error(errorMessage(error)),
    onSettled: refresh,
  });

  return (
    <div className="overflow-x-auto rounded-box bg-base-100 shadow-sm">
      {voiding && (
        <VoidDialog
          key={voiding.id}
          line={voiding}
          isOpen
          onOpenChange={(open) => !open && setVoidingId(null)}
          isPending={voidMutation.isPending}
          onConfirm={(input) => voidMutation.mutateAsync({ orderItemId: voiding.id, ...input })}
        />
      )}
      <table className="table text-base" aria-label={t("order.lines")}>
        <thead>
          <tr>
            <th>{t("order.line")}</th>
            <th className="hidden md:table-cell">{t("order.sku")}</th>
            <th className="text-end">{t("order.quantity")}</th>
            <th className="text-end">{t("order.activeQuantity")}</th>
            <th>{t("order.pickStatusLabel")}</th>
            <th>{t("notes.title")}</th>
          </tr>
        </thead>
        <tbody>
          {order.lines.map((line) => (
            <tr key={line.id} className={line.physical ? "h-16" : "h-16 opacity-60"}>
              <td>
                <div className="font-semibold">{line.name}</div>
                {line.attributes.length > 0 && (
                  // Size, pack and checkout options, as the store names them (store data, not UI text).
                  <dl className="mt-1 space-y-0.5 text-sm">
                    {line.attributes.map((a, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: names can repeat; order is fixed
                      <div key={i}>
                        <dt className="inline text-base-content/70">{a.name}:</dt>{" "}
                        <dd className="inline font-medium">{a.option}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {!line.physical && (
                  <span className="badge badge-ghost badge-sm">{t("order.notPhysical")}</span>
                )}
                {line.substitutionNote && <div className="text-sm">{line.substitutionNote}</div>}
                {/* An undone void is history, not state: the line is whole again. */}
                {order.voids
                  .filter((v) => v.orderItemId === line.id && v.undoneAt === null)
                  .map((voided) => (
                    <VoidRow
                      key={voided.id}
                      voided={voided}
                      lineQuantity={line.quantity}
                      onUndo={mayVoid ? (v) => undoMutation.mutate(v) : undefined}
                      isPending={undoMutation.isPending && undoMutation.variables?.id === voided.id}
                    />
                  ))}
                {mayVoid && line.activeQuantity > 0 && (
                  <Button
                    className="btn-outline btn-error btn-sm mt-1"
                    onPress={() => setVoidingId(line.id)}
                  >
                    {t("voids.button")}
                  </Button>
                )}
              </td>
              <td className="hidden md:table-cell">{line.sku}</td>
              <td className="text-end tabular-nums">{line.quantity}</td>
              <td className="text-end tabular-nums">{line.activeQuantity}</td>
              <td>
                {/* Nobody picks a non-physical line, so its pick status means nothing. */}
                {line.physical && (
                  <>
                    {t(`order.pickStatus.${line.pickStatus}`)}
                    {line.pickStatus !== "PENDING" && (
                      <span className="ms-2 text-sm tabular-nums opacity-70">
                        {t("order.picked", {
                          picked: line.pickedQuantity,
                          expected: line.activeQuantity,
                        })}
                      </span>
                    )}
                    {line.pickedBy && line.pickedAt && (
                      <div className="text-sm opacity-70">
                        {t("order.pickedBy", {
                          name: line.pickedBy.name,
                          time: format.dateTime(line.pickedAt, {
                            dateStyle: "short",
                            timeStyle: "short",
                          }),
                        })}
                      </div>
                    )}
                  </>
                )}
              </td>
              <td>
                <NoteOn notes={notes} option={notes.targets.line(line.id)} count={line.noteCount} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NoteOn({
  notes,
  option,
  count,
}: {
  notes: NotesProps;
  option: TargetOption;
  count: number;
}) {
  return (
    <NoteOnTarget
      orderId={notes.orderId}
      canWriteCustomer={notes.canWriteCustomer}
      targets={notes.targets.all}
      target={option.target}
      name={option.label}
      count={count}
    />
  );
}

function OrderPackages({ order, notes }: { order: Order; notes: NotesProps }) {
  const t = useTranslations();
  if (order.packages.length === 0) return null;
  return (
    <div className="space-y-2">
      <h2 className="text-xl font-bold">{t("order.packages")}</h2>
      <ul className="grid gap-2 md:grid-cols-2">
        {order.packages.map((pkg) => (
          <li
            key={pkg.id}
            className="rounded-box bg-base-100 p-4 shadow-sm"
            data-testid="order-package"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="font-semibold">
                {t("order.package", { number: pkg.number })}
                {pkg.liveLabel && (
                  <span className="badge badge-info ms-2">{t("order.liveLabel")}</span>
                )}
              </div>
              <NoteOn notes={notes} option={notes.targets.pkg(pkg.id)} count={pkg.noteCount} />
            </div>
            <div className="text-sm">
              {/* Weights wait for the weighing ticket, which owns display units. */}
              {pkg.boxName ?? (pkg.dimensions ? t("pack.custom") : t("order.noBox"))} ·{" "}
              {t("order.units", { count: pkg.units })}
            </div>
            {pkg.items.length > 0 && (
              <ul className="mt-1 text-sm" data-testid="order-package-items">
                {pkg.items.map((item) => (
                  <li key={item.orderItemId}>
                    {item.name} ×{item.quantity}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The order's quality issues, open first, with the button that reports a new one (FR-QI-01). */
function ExceptionsPanel({
  order,
  canReport,
  canWriteCustomer,
}: {
  order: Order;
  canReport: boolean;
  canWriteCustomer: boolean;
}) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const [reporting, setReporting] = useState(false);
  const report = useMutation({
    mutationFn: (input: ReportIssueDialogInput) =>
      client.issues.report({ orderId: order.id, ...input }),
    onSuccess: () => toast.success(t("issues.reported")),
    onError: (error) => toast.error(errorMessage(error)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: orpc.orders.key() }),
  });
  const targets = [
    ...order.lines.map((l) => ({
      orderItemId: l.id,
      label: t("issues.line", { name: l.name }),
    })),
    ...order.packages.map((p) => ({
      packageId: p.id,
      label: t("issues.package", { number: p.number }),
    })),
  ];

  return (
    <section aria-labelledby="exceptions-heading" className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h2 id="exceptions-heading" className="text-xl font-bold">
          {t("issues.panel")}
        </h2>
        {canReport && order.status !== "CANCELLED" && (
          <Button className="btn-outline btn-warning" onPress={() => setReporting(true)}>
            {t("issues.button")}
          </Button>
        )}
      </div>
      {reporting && (
        <ReportIssueDialog
          orderId={order.id}
          status={order.status}
          heldFromStatus={order.heldFromStatus}
          canWriteCustomer={canWriteCustomer}
          targets={targets}
          isOpen
          onOpenChange={(open) => !open && setReporting(false)}
          isPending={report.isPending}
          onReport={report.mutateAsync}
        />
      )}
      {order.issues.length === 0 ? (
        <p className="text-sm opacity-70">{t("issues.none")}</p>
      ) : (
        <ul className="space-y-2">
          {order.issues.map((issue) => (
            <li key={issue.id}>
              <IssueCard issue={issue} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
