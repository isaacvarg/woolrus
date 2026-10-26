"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  PackageBoxInput,
  PackLine,
  PackPackage,
  PackResult,
  PackView,
  WeightDisplay,
} from "@woolrus/contracts";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/fields";
import { Menu, MenuItem } from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import { useErrorMessage } from "@/lib/errors";
import { client, orpc } from "@/lib/orpc";
import { BoxDialog } from "./box-dialog";
import { OverweightDialog, overweightMax, WeightField } from "./weight-field";

// The pack screen (SPEC-packing "UI", FR-PACK-01…03). Taps apply at once and the server confirms
// them (NFR-PERF-02); writes run one at a time per order so they land in the order they were made.

const priorityBadge: Record<number, string> = { 1: "badge-warning", 2: "badge-error" };

/** Units moved into (positive) or out of (negative) a package. */
type Move = { pkg: PackPackage; line: PackLine; delta: number };

/** What the server will make of a move, so the screen can show it before the answer comes. */
function applyMove(view: PackView, { pkg, line, delta }: Move): PackView {
  const lines = view.lines.map((l) => {
    if (l.id !== line.id) return l;
    const held = l.packedIn.find((p) => p.packageId === pkg.id)?.quantity ?? 0;
    const packedIn = [
      ...l.packedIn.filter((p) => p.packageId !== pkg.id),
      ...(held + delta > 0
        ? [{ packageId: pkg.id, number: pkg.number, quantity: held + delta }]
        : []),
    ].sort((a, b) => a.number - b.number);
    return { ...l, packedIn, unassigned: Math.max(l.unassigned - delta, 0) };
  });
  const packages = view.packages.map((p) => {
    if (p.id !== pkg.id) return p;
    const held = p.items.find((it) => it.orderItemId === line.id)?.quantity ?? 0;
    const items = [
      ...p.items.filter((it) => it.orderItemId !== line.id),
      ...(held + delta > 0
        ? [{ orderItemId: line.id, name: line.name, quantity: held + delta }]
        : []),
    ];
    return { ...p, items, units: p.units + delta };
  });
  return { ...view, lines, packages };
}

const applyResult = (view: PackView, result: PackResult): PackView => ({ ...view, ...result });

export function PackScreen({ orderId, userId }: { orderId: string; userId: string | null }) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const view = useQuery(orpc.packing.view.queryOptions({ input: { orderId } }));

  if (view.isPending) return <p>{t("common.loading")}</p>;
  if (view.error) {
    return (
      <p role="alert" className="alert alert-error">
        {errorMessage(view.error)}
      </p>
    );
  }
  return <PackLayout view={view.data} userId={userId} />;
}

type Dialogs =
  | { kind: "add" }
  | { kind: "change"; pkg: PackPackage }
  | { kind: "delete"; pkg: PackPackage }
  | { kind: "overweight"; pkg: PackPackage; weightOz: number; maxOz: number };

type Weigh = { pkg: PackPackage; weightOz: number; overrideReason?: string };

function PackLayout({ view, userId }: { view: PackView; userId: string | null }) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const { order } = view;
  const viewKey = orpc.packing.view.queryKey({ input: { orderId: order.id } });
  const writeKey = ["packWrite", order.id];
  const writeScope = `pack:${order.id}`;
  const canPack = order.status === "PACKING" && order.claim?.userId === userId;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The last package until the packer picks one; a deleted selection falls back the same way.
  const selected =
    view.packages.find((p) => p.id === selectedId) ?? view.packages[view.packages.length - 1];
  const [dialog, setDialog] = useState<Dialogs | null>(null);

  const accept = (result: PackResult) => {
    queryClient.setQueryData<PackView>(viewKey, (v) => (v ? applyResult(v, result) : v));
    // A refetch started before this write committed can land after it and undo the card;
    // invalidating cancels that one and reads again after the commit.
    void queryClient.invalidateQueries({ queryKey: viewKey });
  };
  const refuse = (error: unknown) => {
    toast.error(errorMessage(error));
    void queryClient.invalidateQueries({ queryKey: viewKey });
  };

  const move = useMutation({
    mutationKey: writeKey,
    // One at a time per order: a tap and its undo reach the server in the order they were made.
    scope: { id: writeScope },
    mutationFn: ({ pkg, line, delta }: Move) =>
      delta > 0
        ? client.packing.packUnits({ packageId: pkg.id, orderItemId: line.id, quantity: delta })
        : client.packing.unpackUnits({
            packageId: pkg.id,
            orderItemId: line.id,
            quantity: -delta,
          }),
    onMutate: async (m) => {
      await queryClient.cancelQueries({ queryKey: viewKey });
      const previous = queryClient.getQueryData<PackView>(viewKey);
      if (previous) queryClient.setQueryData(viewKey, applyMove(previous, m));
      return { previous };
    },
    onSuccess: (result) => {
      // Later taps are already on screen; only the last answer may replace them.
      if (queryClient.isMutating({ mutationKey: writeKey }) > 1) return;
      accept(result);
    },
    onError: (error, _m, context) => {
      if (context?.previous) queryClient.setQueryData(viewKey, context.previous);
      refuse(error);
    },
  });

  const closeDialog = () => setDialog(null);
  const add = useMutation({
    mutationKey: writeKey,
    scope: { id: writeScope },
    mutationFn: ({ box, idempotencyKey }: { box: PackageBoxInput; idempotencyKey: string }) =>
      client.packing.addPackage({ orderId: order.id, box, idempotencyKey }),
    onSuccess: (result) => {
      const known = new Set(view.packages.map((p) => p.id));
      const created = result.packages.find((p) => !known.has(p.id));
      accept(result);
      if (created) {
        setSelectedId(created.id);
        toast.success(t("pack.added", { number: created.number }));
      }
      closeDialog();
    },
    onError: refuse,
  });
  const change = useMutation({
    mutationKey: writeKey,
    scope: { id: writeScope },
    mutationFn: ({ pkg, box }: { pkg: PackPackage; box: PackageBoxInput }) =>
      client.packing.setBox({ packageId: pkg.id, box }),
    onSuccess: (result) => {
      accept(result);
      closeDialog();
    },
    onError: refuse,
  });
  const remove = useMutation({
    mutationKey: writeKey,
    scope: { id: writeScope },
    mutationFn: (pkg: PackPackage) => client.packing.deletePackage({ packageId: pkg.id }),
    onSuccess: (result) => {
      accept(result);
      closeDialog();
    },
    onError: refuse,
  });
  // A weight above the box's max asks for a reason first; the same mutation saves it with one.
  const weigh = useMutation({
    mutationKey: writeKey,
    scope: { id: writeScope },
    mutationFn: ({ pkg, weightOz, overrideReason }: Weigh) =>
      client.packing.setWeight({ packageId: pkg.id, weightOz, overrideReason }),
    onSuccess: (result) => {
      accept(result);
      toast.success(t("pack.weightSaved"));
      closeDialog();
    },
    onError: (error, { pkg, weightOz }) => {
      const maxOz = overweightMax(error);
      if (maxOz === null) return refuse(error);
      setDialog({ kind: "overweight", pkg, weightOz, maxOz });
    },
  });
  const settings = useQuery(orpc.settings.public.queryOptions());
  // Until settings load, use the schema default so the screen isn't held back.
  const weightDisplay = settings.data?.weightDisplay ?? "LB_OZ";
  const unweighed = view.packages.filter((p) => p.weightOz === null).length;

  const putAll = useMutation({
    mutationKey: writeKey,
    scope: { id: writeScope },
    mutationFn: (pkg: PackPackage) => client.packing.packRemaining({ packageId: pkg.id }),
    onSuccess: accept,
    onError: refuse,
  });

  const toPack = view.lines.filter((l) => l.unassigned > 0 || l.tooMany > 0);
  const unassignedUnits = view.lines.reduce((sum, l) => sum + l.unassigned, 0);
  const putIn = (line: PackLine, delta: number) =>
    selected && move.mutate({ pkg: selected, line, delta });

  return (
    <section className="mx-auto max-w-6xl space-y-4 pb-28">
      <PackHeader view={view} />
      <PackBanner view={view} userId={userId} />

      {view.customerNote && (
        <div className="alert alert-info">
          <span className="font-semibold">{t("order.customerNote")}:</span>
          <span className="whitespace-pre-line">{view.customerNote}</span>
        </div>
      )}

      {view.lines.length === 0 ? (
        <p className="alert">{t("pack.nothingToPack")}</p>
      ) : (
        <div className="grid items-start gap-6 landscape:grid-cols-2">
          <div className="space-y-3">
            <h2 className="text-xl font-bold">{t("pack.items")}</h2>
            {canPack && !selected && (
              <p className="alert alert-warning">{t("pack.noPackageSelected")}</p>
            )}
            {toPack.length === 0 ? (
              <p className="alert alert-success" data-testid="pack-all-packed">
                {t("pack.allPacked")}
              </p>
            ) : (
              <ul className="grid gap-3" aria-label={t("pack.items")}>
                {toPack.map((line) => (
                  <ItemCard
                    key={line.id}
                    line={line}
                    disabled={!canPack || !selected}
                    onPut={(count) => putIn(line, count)}
                  />
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-xl font-bold">{t("pack.packages")}</h2>
              {canPack && (
                <Button className="btn-primary btn-lg" onPress={() => setDialog({ kind: "add" })}>
                  {t("pack.addPackage")}
                </Button>
              )}
            </div>
            {view.packages.length > 0 && canPack && (
              <p className="text-sm">{t("pack.selectedHint")}</p>
            )}
            <ul className="grid gap-3" aria-label={t("pack.packages")}>
              {view.packages.map((pkg) => (
                <PackageCard
                  key={pkg.id}
                  pkg={pkg}
                  lines={view.lines}
                  isSelected={pkg.id === selected?.id}
                  disabled={!canPack}
                  onSelect={() => setSelectedId(pkg.id)}
                  onTakeOut={(line) => move.mutate({ pkg, line, delta: -1 })}
                  onChangeBox={() => setDialog({ kind: "change", pkg })}
                  onPutAll={() => putAll.mutate(pkg)}
                  putAllDisabled={unassignedUnits === 0}
                  onDelete={() => setDialog({ kind: "delete", pkg })}
                  weightDisplay={weightDisplay}
                  weighing={weigh.isPending && weigh.variables?.pkg.id === pkg.id}
                  onWeigh={(weightOz, overrideReason) =>
                    weigh.mutate({ pkg, weightOz, overrideReason })
                  }
                />
              ))}
            </ul>
          </div>
        </div>
      )}

      {canPack && view.lines.length > 0 && (
        <footer
          data-toast-clearance
          className="fixed inset-x-0 bottom-0 z-10 space-y-1 border-t border-base-300 bg-base-100 p-4"
        >
          <p className="font-semibold" data-testid="pack-unassigned">
            {t("pack.unassigned", { count: unassignedUnits })}
          </p>
          <p className="text-sm" data-testid="pack-unweighed">
            {t("pack.noWeight", { count: unweighed })}
          </p>
          {view.unmet.length > 0 && (
            <ul className="list-disc ps-6 text-sm" data-testid="pack-unmet">
              {view.unmet.map((condition) => (
                <li key={`${condition.messageKey}:${JSON.stringify(condition.params)}`}>
                  {t.has(condition.messageKey)
                    ? t(condition.messageKey, condition.params as never)
                    : t("errors.internal")}
                </li>
              ))}
            </ul>
          )}
        </footer>
      )}

      {dialog?.kind === "add" && (
        <BoxDialog
          title={t("pack.chooseBox")}
          boxes={view.boxes}
          isPending={add.isPending}
          onChoose={(box) => add.mutate({ box, idempotencyKey: crypto.randomUUID() })}
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === "change" && (
        <BoxDialog
          title={t("pack.changeBoxTitle", { number: dialog.pkg.number })}
          boxes={view.boxes}
          isPending={change.isPending}
          onChoose={(box) => change.mutate({ pkg: dialog.pkg, box })}
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === "overweight" && (
        <OverweightDialog
          weightOz={dialog.weightOz}
          maxOz={dialog.maxOz}
          weightDisplay={weightDisplay}
          isPending={weigh.isPending}
          onSave={(overrideReason) =>
            weigh.mutate({ pkg: dialog.pkg, weightOz: dialog.weightOz, overrideReason })
          }
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === "delete" && (
        <Dialog
          title={t("pack.deleteTitle", { number: dialog.pkg.number })}
          isOpen
          onOpenChange={(open) => !open && closeDialog()}
        >
          {(close) => (
            <div className="space-y-4">
              <p>{t("pack.deleteHint")}</p>
              <div className="modal-action">
                <Button className="btn-ghost" onPress={close}>
                  {t("order.back")}
                </Button>
                <Button
                  className="btn-error"
                  isPending={remove.isPending}
                  onPress={() => remove.mutate(dialog.pkg)}
                >
                  {t("pack.deleteConfirm")}
                </Button>
              </div>
            </div>
          )}
        </Dialog>
      )}
    </section>
  );
}

function PackHeader({ view }: { view: PackView }) {
  const t = useTranslations();
  const { order } = view;
  const level = Math.min(order.priority, 2) as 0 | 1 | 2;
  return (
    <header className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-3xl font-bold">{t("pack.title", { number: order.number })}</h1>
        <span className={`badge badge-lg ${priorityBadge[level] ?? "badge-ghost"}`}>
          {t(`queue.priorityLevel.${level}`)}
        </span>
        <Link href={`/orders/${order.id}`} className="btn btn-ghost btn-sm ms-auto">
          {t("pack.orderDetails")}
        </Link>
      </div>
      <p className="text-lg">{order.customerName}</p>
    </header>
  );
}

/** Why the screen is locked, when it is: the order left Packing, or the claim isn't the viewer's. */
function PackBanner({ view, userId }: { view: PackView; userId: string | null }) {
  const t = useTranslations();
  const { order } = view;
  let message: string | null = null;
  if (order.status !== "PACKING") {
    message = t("pack.notPacking", { status: t(`status.${order.status}`) });
  } else if (!order.claim) {
    message = t("pack.unclaimed");
  } else if (order.claim.userId !== userId) {
    message = t("pack.claimedByOther", { name: order.claim.userName });
  }
  if (!message) return null;
  return (
    <div role="status" className="alert alert-warning" data-testid="pack-banner">
      <span className="grow">{message}</span>
      <Link href={`/orders/${order.id}`} className="btn-sm">
        {t("pack.orderDetails")}
      </Link>
    </div>
  );
}

/** "4 in #1 · 2 in #2", and what's wrong when a line has more in boxes than it needs. */
function WhereRest({ line }: { line: PackLine }) {
  const t = useTranslations();
  if (line.packedIn.length === 0) return null;
  return (
    <div className="text-sm" data-testid="pack-where">
      {line.packedIn
        .map((p) => t("pack.packedIn", { count: p.quantity, number: p.number }))
        .join(" · ")}
    </div>
  );
}

function ItemCard({
  line,
  disabled,
  onPut,
}: {
  line: PackLine;
  disabled: boolean;
  onPut: (count: number) => void;
}) {
  const t = useTranslations();
  const [count, setCount] = useState(1);
  const many = Math.min(Math.max(count, 1), Math.max(line.unassigned, 1));
  const tooMany = line.tooMany > 0 ? line.packedIn[line.packedIn.length - 1] : undefined;

  return (
    <li
      className={`rounded-box border-2 bg-base-100 shadow-sm ${line.tooMany > 0 ? "border-error" : "border-base-300"}`}
      data-testid="pack-item"
    >
      <Button
        className="btn-ghost h-auto min-h-40 w-full items-start justify-start gap-4 rounded-box p-4 text-start font-normal"
        isDisabled={disabled || line.unassigned === 0}
        aria-label={t("pack.putOne", { name: line.name })}
        onPress={() => onPut(1)}
      >
        {line.imageUrl ? (
          // Store images come from the shop's own domain; next/image would need it configured.
          // biome-ignore lint/performance/noImgElement: see above
          <img src={line.imageUrl} alt="" className="size-24 shrink-0 rounded-box object-cover" />
        ) : (
          <div className="size-24 shrink-0 rounded-box bg-base-200" aria-hidden="true" />
        )}
        <span className="min-w-0 grow space-y-1">
          <span className="block text-xl font-bold">{line.name}</span>
          {line.sku && <span className="block text-sm">{t("pack.sku", { sku: line.sku })}</span>}
          {line.attributes.length > 0 && (
            // Size, pack and checkout options, as the store names them (store data, not UI text).
            <span className="block space-y-0.5 text-sm">
              {line.attributes.map((a, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: names can repeat; order is fixed
                <span key={i} className="block">
                  <span className="text-base-content/70">{a.name}:</span>{" "}
                  <span className="font-medium">{a.option}</span>
                </span>
              ))}
            </span>
          )}
          {line.substitutionNote && (
            <span className="block text-sm" data-testid="pack-substitution">
              {line.substitutionNote}
            </span>
          )}
          <WhereRest line={line} />
          {tooMany && (
            <span className="block font-semibold text-error">
              {t("pack.tooMany", { count: line.tooMany, number: tooMany.number })}
            </span>
          )}
        </span>
        <span className="shrink-0 text-end text-4xl font-bold tabular-nums" data-testid="pack-left">
          {t("pack.left", { count: line.unassigned })}
        </span>
      </Button>
      {line.unassigned > 1 && !disabled && (
        <div className="flex items-center justify-end gap-2 border-t border-base-300 p-2">
          <Button
            className="btn-outline btn-lg min-w-16 text-2xl"
            aria-label={t("pack.oneFewer", { name: line.name })}
            isDisabled={many <= 1}
            onPress={() => setCount(many - 1)}
          >
            −
          </Button>
          <span className="w-10 text-center text-2xl font-bold tabular-nums">{many}</span>
          <Button
            className="btn-outline btn-lg min-w-16 text-2xl"
            aria-label={t("pack.oneMore", { name: line.name })}
            isDisabled={many >= line.unassigned}
            onPress={() => setCount(many + 1)}
          >
            +
          </Button>
          <Button className="btn-secondary btn-lg" onPress={() => onPut(many)}>
            {t("pack.putCount", { count: many })}
          </Button>
        </div>
      )}
    </li>
  );
}

function PackageCard({
  pkg,
  lines,
  isSelected,
  disabled,
  onSelect,
  onTakeOut,
  onChangeBox,
  onPutAll,
  putAllDisabled,
  onDelete,
  weightDisplay,
  weighing,
  onWeigh,
}: {
  weightDisplay: WeightDisplay;
  weighing: boolean;
  onWeigh: (weightOz: number, overrideReason?: string) => void;
  pkg: PackPackage;
  lines: PackLine[];
  isSelected: boolean;
  disabled: boolean;
  onSelect: () => void;
  onTakeOut: (line: PackLine) => void;
  onChangeBox: () => void;
  onPutAll: () => void;
  putAllDisabled: boolean;
  onDelete: () => void;
}) {
  const t = useTranslations();
  const size = pkg.box ?? pkg.dimensions;
  const sizeText =
    size &&
    t("pack.dimensions", { length: size.lengthIn, width: size.widthIn, height: size.heightIn });

  return (
    <li
      className={`rounded-box border-2 bg-base-100 shadow-sm ${isSelected ? "border-primary ring-2 ring-primary" : "border-base-300"}`}
      data-testid="pack-package"
      data-selected={isSelected || undefined}
    >
      <div className="flex items-stretch">
        <Button
          className="btn-ghost h-auto min-h-20 grow justify-start rounded-box p-4 text-start font-normal"
          aria-pressed={isSelected}
          aria-label={t("pack.select", { number: pkg.number })}
          isDisabled={disabled}
          onPress={onSelect}
        >
          <span className="block space-y-1">
            <span className="flex items-center gap-2">
              <span className="text-xl font-bold">{t("pack.package", { number: pkg.number })}</span>
              {isSelected && (
                <span className="badge badge-primary">
                  <span aria-hidden="true">✓ </span>
                  {t("pack.selected")}
                </span>
              )}
            </span>
            <span className="block text-sm">
              {pkg.box?.name ?? t("pack.custom")}
              {sizeText && ` · ${sizeText}`} · {t("pack.units", { count: pkg.units })}
            </span>
          </span>
        </Button>
        {!disabled && (
          <div className="p-2">
            <Menu
              label={t("pack.menu", { number: pkg.number })}
              trigger="⋯"
              triggerClassName="btn-ghost btn-lg text-2xl"
            >
              <MenuItem onAction={onChangeBox}>{t("pack.changeBox")}</MenuItem>
              <MenuItem isDisabled={putAllDisabled} onAction={onPutAll}>
                {t("pack.putEverything")}
              </MenuItem>
              <MenuItem danger onAction={onDelete}>
                {t("pack.delete")}
              </MenuItem>
            </Menu>
          </div>
        )}
      </div>
      <div className="space-y-2 border-t border-base-300 p-4">
        {pkg.weightStale && pkg.weightOz !== null && (
          <div role="status" className="alert alert-warning" data-testid="pack-stale">
            <span className="grow">{t("pack.stale")}</span>
            {!disabled && (
              <Button
                className="btn-sm"
                isPending={weighing}
                // Same value again confirms it; a kept reason travels with it.
                onPress={() =>
                  pkg.weightOz !== null && onWeigh(pkg.weightOz, pkg.overrideReason ?? undefined)
                }
              >
                {t("pack.staleConfirm")}
              </Button>
            )}
          </div>
        )}
        {pkg.overrideReason && (
          <p className="text-sm" data-testid="pack-override">
            <span className="badge badge-warning me-2">{t("pack.overweightBadge")}</span>
            {pkg.overrideReason}
          </p>
        )}
        <WeightField
          // Remount when the saved weight changes, so the fields show what the server kept.
          key={pkg.weightOz ?? "none"}
          weightOz={pkg.weightOz}
          maxWeightOz={pkg.box?.maxWeightOz ?? null}
          weightDisplay={weightDisplay}
          disabled={disabled}
          isPending={weighing}
          onSave={(oz) => onWeigh(oz)}
        />
      </div>
      {pkg.items.length === 0 ? (
        <p className="border-t border-base-300 p-4 text-sm">{t("pack.empty")}</p>
      ) : (
        <ul className="divide-y divide-base-300 border-t border-base-300">
          {pkg.items.map((item) => {
            const line = lines.find((l) => l.id === item.orderItemId);
            return (
              <li key={item.orderItemId} className="flex items-center gap-2 px-4 py-2">
                <span className="grow">{item.name}</span>
                <span className="text-xl font-bold tabular-nums">×{item.quantity}</span>
                {line && !disabled && (
                  <Button
                    className="btn-outline btn-lg min-w-16 text-2xl"
                    aria-label={t("pack.takeOut", { name: item.name, number: pkg.number })}
                    onPress={() => onTakeOut(line)}
                  >
                    −
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}
