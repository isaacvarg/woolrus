"use client";

import { useQuery } from "@tanstack/react-query";
import type { OrderView as Order } from "@woolrus/contracts";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import type { TargetOption } from "@/components/notes/note-composer";
import { useTargetName } from "@/components/notes/note-list";
import { NoteOnTarget, NotesPanel } from "@/components/notes/notes-panel";
import { useErrorMessage } from "@/lib/errors";
import { orpc } from "@/lib/orpc";
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
}: {
  id: string;
  userId: string | null;
  canWriteCustomer: boolean;
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
  return <OrderLayout order={order.data} userId={userId} canWriteCustomer={canWriteCustomer} />;
}

function OrderLayout({
  order,
  userId,
  canWriteCustomer,
}: {
  order: Order;
  userId: string | null;
  canWriteCustomer: boolean;
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
          <OrderLines order={order} notes={notes} />
          <OrderPackages order={order} notes={notes} />
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

function OrderLines({ order, notes }: { order: Order; notes: NotesProps }) {
  const t = useTranslations();
  const format = useFormatter();
  return (
    <div className="overflow-x-auto rounded-box bg-base-100 shadow-sm">
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
