"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  PackageBoxInput,
  PackageItemView,
  PackLine,
  PackPackage,
  PackResult,
  PackView,
  WeightDisplay,
} from "@woolrus/contracts";
import { formatWeight } from "@woolrus/core/format";
import { isLotCode, lotLabel } from "@woolrus/core/lot-codes";
import { Box, EllipsisVertical, PencilSparkles, Weight } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { ReportIssueFlow } from "@/components/exceptions/report-issue-flow";
import { VoidDialog } from "@/components/exceptions/void-dialog";
import { CustomsNotice } from "@/components/shipping/customs-notice";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/fields";
import { Menu, MenuItem } from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import { useErrorMessage } from "@/lib/errors";
import { client, orpc } from "@/lib/orpc";
import { playScanSound, useScanner } from "@/lib/scanner";
import { ScanBanner, type ScanOutcome } from "../../pick/[orderId]/pick-screen";
import { BoxDialog } from "./box-dialog";
import { OrderDrawer, PackageNoteDialog } from "./order-drawer";
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
    const current = p.items.find((it) => it.orderItemId === line.id);
    const held = current?.quantity ?? 0;
    // Lots stay as they were until the server's answer says how the split rule moved them.
    const items = [
      ...p.items.filter((it) => it.orderItemId !== line.id),
      ...(held + delta > 0
        ? [
            {
              orderItemId: line.id,
              name: line.name,
              quantity: held + delta,
              needsLot: current?.needsLot ?? false,
              lots: current?.lots ?? [],
            },
          ]
        : []),
    ];
    return { ...p, items, units: p.units + delta };
  });
  return { ...view, lines, packages };
}

const applyResult = (view: PackView, result: PackResult): PackView => ({ ...view, ...result });

export function PackScreen({
  orderId,
  userId,
  canVoid,
  canReport,
  canWriteCustomer,
}: {
  orderId: string;
  userId: string | null;
  canVoid: boolean;
  canReport: boolean;
  canWriteCustomer: boolean;
}) {
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
  return (
    <PackLayout
      view={view.data}
      userId={userId}
      canVoid={canVoid}
      canReport={canReport}
      canWriteCustomer={canWriteCustomer}
    />
  );
}

type Dialogs =
  | { kind: "add" }
  | { kind: "change"; pkg: PackPackage }
  | { kind: "delete"; pkg: PackPackage }
  | { kind: "note"; pkg: PackPackage }
  | { kind: "items"; pkgId: string }
  | { kind: "overweight"; pkg: PackPackage; weightOz: number; maxOz: number };

type Weigh = { pkg: PackPackage; weightOz: number; overrideReason?: string };

function PackLayout({
  view,
  userId,
  canVoid,
  canReport,
  canWriteCustomer,
}: {
  view: PackView;
  userId: string | null;
  canVoid: boolean;
  canReport: boolean;
  canWriteCustomer: boolean;
}) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const router = useRouter();
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
  const [voidingId, setVoidingId] = useState<string | null>(null);
  const voiding = view.lines.find((l) => l.id === voidingId);
  const [reporting, setReporting] = useState<{ orderItemId?: string; packageId?: string } | null>(
    null,
  );
  // Like voids, any stage and no claim; the server refuses a finished or cancelled order.
  const mayReport = canReport && order.status !== "COMPLETED" && order.status !== "CANCELLED";
  // Any stage can void and it needs no claim; the server also refuses an order with a live label.
  const mayVoid = canVoid && order.status !== "COMPLETED" && order.status !== "CANCELLED";
  const voidMutation = useMutation({
    mutationFn: (input: { orderItemId: string; quantity: number; reason: string }) =>
      client.voids.void({ orderId: order.id, ...input }),
    onSuccess: (_result, input) => {
      const name = view.lines.find((l) => l.id === input.orderItemId)?.name ?? "";
      toast.success(t("voids.done", { count: input.quantity, name }));
    },
    onError: (error) => toast.error(errorMessage(error)),
    // The void also changed the boxes, so the whole view is read again.
    onSettled: () =>
      Promise.all(
        [orpc.packing.key(), orpc.orders.key()].map((queryKey) =>
          queryClient.invalidateQueries({ queryKey }),
        ),
      ),
  });

  const accept = async (result: PackResult) => {
    // A refetch started before this write committed can land after it and undo the card, so it is
    // cancelled first. The write's own answer is the new state; the order_changed event it sent
    // makes the screen read again once it has committed, so there's no refetch to ask for here.
    await queryClient.cancelQueries({ queryKey: viewKey });
    queryClient.setQueryData<PackView>(viewKey, (v) => (v ? applyResult(v, result) : v));
  };
  const refuse = (error: unknown) => {
    toast.error(errorMessage(error));
    void queryClient.invalidateQueries({ queryKey: viewKey });
  };

  const [scanned, setScanned] = useState<ScanOutcome | null>(null);
  const scan = useMutation({
    // Same key as the taps, so a tap's answer waits while a scan is still in flight.
    mutationKey: writeKey,
    // Same lane as taps: a scan and a tap on the same line land in the order they were made.
    scope: { id: writeScope },
    // The key is made with the scan, not per request, so a retried request replays it.
    mutationFn: ({ pkg, code, scanId }: { pkg: PackPackage; code: string; scanId: string }) =>
      client.packing.scan({ packageId: pkg.id, code, scanId }),
    onSuccess: (result, { pkg }) => {
      accept(result);
      playScanSound(true);
      // The line the unit went on is the one whose share in this package grew.
      const held = (l: PackLine) => l.packedIn.find((p) => p.packageId === pkg.id)?.quantity ?? 0;
      const before = new Map(view.lines.map((l) => [l.id, held(l)]));
      const line = result.lines.find((l) => held(l) > (before.get(l.id) ?? 0));
      setScanned({
        ok: true,
        at: Date.now(),
        message: t("pack.scanned", {
          name: line?.name ?? "",
          number: pkg.number,
          left: line?.unassigned ?? 0,
        }),
      });
    },
    onError: (error) => {
      playScanSound(false);
      setScanned({ ok: false, at: Date.now(), message: errorMessage(error) });
    },
  });
  const scanLot = useMutation({
    mutationKey: writeKey,
    scope: { id: writeScope },
    mutationFn: ({ pkg, code, scanId }: { pkg: PackPackage; code: string; scanId: string }) =>
      client.packing.scanLot({ packageId: pkg.id, code, scanId }),
    onSuccess: (result, { pkg }) => {
      accept(result);
      playScanSound(true);
      // The box line whose lots changed is the one this scan went on.
      const lotsOf = (p: PackPackage | undefined, id: string) =>
        JSON.stringify(p?.items.find((it) => it.orderItemId === id)?.lots ?? []);
      const after = result.packages.find((p) => p.id === pkg.id);
      const item = after?.items.find(
        (it) => lotsOf(after, it.orderItemId) !== lotsOf(pkg, it.orderItemId),
      );
      const lot = item?.lots.at(-1)?.lotNumber;
      setScanned({
        ok: true,
        at: Date.now(),
        message: t("pack.lotScanned", {
          lot: lot ? lotLabel(lot) : "",
          name: item?.name ?? "",
          number: pkg.number,
        }),
      });
    },
    onError: (error) => {
      playScanSound(false);
      setScanned({ ok: false, at: Date.now(), message: errorMessage(error) });
    },
  });
  useScanner((code) => {
    if (!selected) {
      playScanSound(false);
      setScanned({ ok: false, at: Date.now(), message: t("pack.noPackageSelected") });
      return;
    }
    // One scan field: a lot label goes to the lot, anything else packs a product (SPEC-lumexia).
    const write = isLotCode(code) ? scanLot : scan;
    write.mutate({ pkg: selected, code, scanId: crypto.randomUUID() });
  }, canPack);

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
  // Finishing waits for the writes before it, so the server sees the packages as they were left.
  const complete = useMutation({
    scope: { id: writeScope },
    mutationFn: (after: "queue" | "next") =>
      client.packing.complete({ orderId: order.id, expectedVersion: order.version, after }),
    onSuccess: ({ nextOrderId }, after) => {
      toast.success(t("order.moved", { number: order.number, status: t("status.QA") }));
      if (nextOrderId) router.push(`/pack/${nextOrderId}`);
      else {
        if (after === "next") toast.success(t("pack.noneLeft"));
        router.push("/queue/packing");
      }
    },
    onError: refuse,
    onSettled: () => queryClient.invalidateQueries({ queryKey: orpc.orders.key() }),
  });

  const weigh = useMutation({
    mutationKey: writeKey,
    scope: { id: writeScope },
    mutationFn: ({ pkg, weightOz, overrideReason }: Weigh) =>
      client.packing.setWeight({ packageId: pkg.id, weightOz, overrideReason }),
    onSuccess: (result) => {
      accept(result);
      // No toast: the card shows the saved weight, and a toast bottom right can cover the next tap.
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
      {voiding && (
        <VoidDialog
          key={voiding.id}
          line={{ id: voiding.id, name: voiding.name, activeQuantity: voiding.quantity }}
          isOpen
          onOpenChange={(open) => !open && setVoidingId(null)}
          isPending={voidMutation.isPending}
          onConfirm={(input) => voidMutation.mutateAsync({ orderItemId: voiding.id, ...input })}
        />
      )}
      {reporting && (
        <ReportIssueFlow
          key={reporting.orderItemId ?? reporting.packageId}
          order={order}
          canWriteCustomer={canWriteCustomer}
          targets={[
            ...view.lines.map((l) => ({
              orderItemId: l.id,
              label: t("issues.line", { name: l.name }),
            })),
            ...view.packages.map((p) => ({
              packageId: p.id,
              label: t("issues.package", { number: p.number }),
            })),
          ]}
          initialTarget={reporting}
          onClose={() => setReporting(null)}
        />
      )}
      <PackHeader view={view} />
      <PackBanner view={view} userId={userId} />
      {canPack && <ScanBanner outcome={scanned} linkTo={[]} linking={false} onLink={() => {}} />}

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
                    onVoid={mayVoid && line.quantity > 0 ? () => setVoidingId(line.id) : undefined}
                    onReport={mayReport ? () => setReporting({ orderItemId: line.id }) : undefined}
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
              {[...view.packages]
                .sort((a, b) => Number(b.id === selected?.id) - Number(a.id === selected?.id))
                .map((pkg) => (
                  <PackageCard
                    key={pkg.id}
                    pkg={pkg}
                    lines={view.lines}
                    isSelected={pkg.id === selected?.id}
                    disabled={!canPack}
                    onSelect={() => setSelectedId(pkg.id)}
                    onEditItems={() => setDialog({ kind: "items", pkgId: pkg.id })}
                    onChangeBox={() => setDialog({ kind: "change", pkg })}
                    onPutAll={() => putAll.mutate(pkg)}
                    putAllDisabled={unassignedUnits === 0}
                    onDelete={() => setDialog({ kind: "delete", pkg })}
                    onAddNote={() => setDialog({ kind: "note", pkg })}
                    onReport={mayReport ? () => setReporting({ packageId: pkg.id }) : undefined}
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

      {canPack && view.lines.length > 0 && view.unmet.length === 0 && !view.order.allVoided && (
        <footer
          data-toast-clearance
          className="fixed inset-x-0 bottom-0 z-10 border-t border-base-300 bg-base-100 p-4"
        >
          <div className="flex justify-end gap-2">
            <Button
              className="btn-outline btn-lg"
              isDisabled={complete.isPending}
              onPress={() => complete.mutate("queue")}
            >
              {t("pack.done")}
            </Button>
            <Button
              className="btn-primary btn-lg"
              isDisabled={complete.isPending}
              onPress={() => complete.mutate("next")}
            >
              {t("pack.doneNext")}
            </Button>
          </div>
        </footer>
      )}

      {dialog?.kind === "add" && (
        <BoxDialog
          title={t("pack.chooseBox")}
          boxes={view.boxes}
          suggestion={view.suggestion}
          weightDisplay={weightDisplay}
          isPending={add.isPending}
          onChoose={(box) => add.mutate({ box, idempotencyKey: crypto.randomUUID() })}
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === "change" && (
        <BoxDialog
          title={t("pack.changeBoxTitle", { number: dialog.pkg.number })}
          boxes={view.boxes}
          // The live package, so the suggestion follows its contents.
          suggestion={
            view.packages.find((p) => p.id === dialog.pkg.id)?.suggestion ?? dialog.pkg.suggestion
          }
          weightDisplay={weightDisplay}
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
      {dialog?.kind === "items" &&
        (() => {
          const pkg = view.packages.find((p) => p.id === dialog.pkgId);
          if (!pkg) return null;
          return (
            <Dialog
              title={t("pack.removeItems", { number: pkg.number })}
              isOpen
              onOpenChange={(open) => !open && closeDialog()}
            >
              {(close) => (
                <div className="space-y-4">
                  <p className="text-sm">{t("pack.removeItemsHint")}</p>
                  {pkg.items.length === 0 ? (
                    <p className="text-sm">{t("pack.empty")}</p>
                  ) : (
                    <ul className="divide-y divide-base-300">
                      {pkg.items.map((item) => {
                        const line = view.lines.find((l) => l.id === item.orderItemId);
                        return (
                          <li key={item.orderItemId} className="flex items-center gap-3 py-2">
                            <ItemThumb url={line?.imageUrl ?? null} className="size-12" />
                            <span className="grow">{item.name}</span>
                            <span className="text-xl font-bold tabular-nums">×{item.quantity}</span>
                            {line && (
                              <Button
                                className="btn-outline btn-lg min-w-16 text-2xl"
                                aria-label={t("pack.takeOut", {
                                  name: item.name,
                                  number: pkg.number,
                                })}
                                onPress={() => move.mutate({ pkg, line, delta: -1 })}
                              >
                                −
                              </Button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  <div className="modal-action">
                    <Button className="btn-ghost" onPress={close}>
                      {t("order.back")}
                    </Button>
                  </div>
                </div>
              )}
            </Dialog>
          );
        })()}
      {dialog?.kind === "note" && (
        <PackageNoteDialog orderId={order.id} pkg={dialog.pkg} onClose={closeDialog} />
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
        <span className="ms-auto flex items-center gap-2">
          <OrderDrawer orderId={order.id} />
          <Link href={`/orders/${order.id}`} className="btn btn-ghost btn-sm">
            {t("pack.orderDetails")}
          </Link>
        </span>
      </div>
      <p className="text-lg">{order.customerName}</p>
      <CustomsNotice orderId={order.id} />
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

/** "4 @ [box] 1 • 2 @ [box] 2", and what's wrong when a line has more in boxes than it needs. */
function WhereRest({ line }: { line: PackLine }) {
  const t = useTranslations();
  if (line.packedIn.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 text-sm" data-testid="pack-where">
      {line.packedIn.map((p, i) => (
        <span key={p.packageId} className="inline-flex items-center gap-1">
          {i > 0 && <span aria-hidden="true">•</span>}
          <span
            className="inline-flex items-center gap-1"
            role="img"
            aria-label={t("pack.packedInBox", { count: p.quantity, number: p.number })}
          >
            {p.quantity} @ <Box className="size-4" aria-hidden="true" /> {p.number}
          </span>
        </span>
      ))}
    </div>
  );
}

function ItemThumb({ url, className }: { url: string | null; className: string }) {
  return url ? (
    // Store images come from the shop's own domain; next/image would need it configured.
    // biome-ignore lint/performance/noImgElement: see above
    <img src={url} alt="" className={`${className} shrink-0 rounded-field object-cover`} />
  ) : (
    <div className={`${className} shrink-0 rounded-field bg-base-200`} aria-hidden="true" />
  );
}

function ItemCard({
  line,
  disabled,
  onPut,
  onVoid,
  onReport,
}: {
  line: PackLine;
  disabled: boolean;
  onPut: (count: number) => void;
  onVoid?: () => void;
  onReport?: () => void;
}) {
  const t = useTranslations();
  const [count, setCount] = useState(1);
  const many = Math.min(Math.max(count, 1), Math.max(line.unassigned, 1));
  const tooMany = line.tooMany > 0 ? line.packedIn[line.packedIn.length - 1] : undefined;

  return (
    <li
      className={`relative rounded-box border-2 bg-base-100 shadow-sm ${line.tooMany > 0 ? "border-error" : "border-base-300"}`}
      data-testid="pack-item"
    >
      <Button
        className="btn-ghost h-auto min-h-40 w-full items-start justify-start gap-4 rounded-box p-4 pe-12 text-start font-normal"
        isDisabled={disabled || line.unassigned === 0}
        aria-label={t("pack.putOne", { name: line.name })}
        onPress={() => onPut(1)}
      >
        <ItemThumb url={line.imageUrl} className="size-24" />
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
      {(onVoid || onReport) && (
        <div className="absolute end-2 top-2">
          <Menu
            label={t("pack.itemMenu", { name: line.name })}
            trigger={<EllipsisVertical className="size-5" aria-hidden="true" />}
            triggerClassName="btn-ghost btn-square btn-sm"
          >
            {onReport && <MenuItem onAction={onReport}>{t("issues.button")}</MenuItem>}
            {onVoid && (
              <MenuItem danger onAction={onVoid}>
                {t("voids.button")}
              </MenuItem>
            )}
          </Menu>
        </div>
      )}
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
  onEditItems,
  onChangeBox,
  onPutAll,
  putAllDisabled,
  onDelete,
  onAddNote,
  onReport,
  weightDisplay,
  weighing,
  onWeigh,
}: {
  onReport?: () => void;
  weightDisplay: WeightDisplay;
  weighing: boolean;
  onWeigh: (weightOz: number, overrideReason?: string) => void;
  pkg: PackPackage;
  lines: PackLine[];
  isSelected: boolean;
  disabled: boolean;
  onSelect: () => void;
  onEditItems: () => void;
  onChangeBox: () => void;
  onPutAll: () => void;
  putAllDisabled: boolean;
  onDelete: () => void;
  onAddNote: () => void;
}) {
  const t = useTranslations();
  const size = pkg.box ?? pkg.dimensions;
  const sizeText =
    size &&
    t("pack.dimensions", { length: size.lengthIn, width: size.widthIn, height: size.heightIn });
  const hasMenu = !disabled || onReport;

  return (
    <li
      className={`relative rounded-box border-2 bg-base-100 shadow-sm ${isSelected ? "border-primary ring-2 ring-primary" : "border-base-300"}`}
      data-testid="pack-package"
      data-selected={isSelected || undefined}
    >
      <Button
        className={`h-auto min-h-20 w-full justify-start p-4 text-start font-normal ${isSelected ? "rounded-t-[inherit] rounded-b-none bg-primary/15 hover:bg-primary/20" : "btn-ghost rounded-box"} ${hasMenu ? "pe-28" : "pe-16"}`}
        aria-pressed={isSelected}
        aria-label={t("pack.select", { number: pkg.number })}
        isDisabled={disabled}
        onPress={onSelect}
      >
        <span className="block space-y-1">
          <span className="flex items-center gap-2">
            <span className="text-xl font-bold">{t("pack.package", { number: pkg.number })}</span>
            {pkg.items.some((it) => it.needsLot && it.lots.length === 0) && (
              <span className="badge badge-warning">{t("pack.lotNeeded")}</span>
            )}
          </span>
          <span className="block text-sm">
            {pkg.box?.name ?? t("pack.custom")}
            {sizeText && ` · ${sizeText}`} · {t("pack.units", { count: pkg.units })}
          </span>
        </span>
      </Button>
      {isSelected && (
        <PencilSparkles
          className="pointer-events-none absolute end-20 top-6 size-7 text-primary"
          aria-hidden="true"
        />
      )}
      {hasMenu && (
        <div className="absolute end-2 top-2">
          <Menu
            label={t("pack.menu", { number: pkg.number })}
            trigger={<EllipsisVertical className="size-6" aria-hidden="true" />}
            triggerClassName="btn-ghost btn-square btn-lg"
          >
            {!disabled && <MenuItem onAction={onChangeBox}>{t("pack.changeBox")}</MenuItem>}
            {!disabled && (
              <MenuItem isDisabled={putAllDisabled} onAction={onPutAll}>
                {t("pack.putEverything")}
              </MenuItem>
            )}
            {!disabled && <MenuItem onAction={onAddNote}>{t("pack.addNote")}</MenuItem>}
            {onReport && <MenuItem onAction={onReport}>{t("issues.packageButton")}</MenuItem>}
            {!disabled && (
              <MenuItem danger onAction={onDelete}>
                {t("pack.delete")}
              </MenuItem>
            )}
          </Menu>
        </div>
      )}
      {isSelected && (
        <>
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
                      pkg.weightOz !== null &&
                      onWeigh(pkg.weightOz, pkg.overrideReason ?? undefined)
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
            {pkg.weightWarning && (
              <p role="status" className="alert alert-warning" data-testid="pack-weight-warning">
                {t(pkg.weightWarning.percent > 0 ? "pack.warnHeavier" : "pack.warnLighter", {
                  percent: Math.abs(pkg.weightWarning.percent),
                })}
              </p>
            )}
            <WeightEditor
              // Remount when the saved weight changes, so the fields show what the server kept.
              key={pkg.weightOz ?? "none"}
              pkg={pkg}
              weightDisplay={weightDisplay}
              disabled={disabled}
              weighing={weighing}
              onWeigh={onWeigh}
            />
          </div>
          {pkg.items.length === 0 ? (
            <p className="border-t border-base-300 p-4 text-sm">{t("pack.empty")}</p>
          ) : (
            <div className="border-t border-base-300">
              <Button
                className="btn-ghost h-auto min-h-16 w-full flex-wrap justify-start gap-x-5 gap-y-2 rounded-box p-4 font-normal"
                aria-label={t("pack.removeItems", { number: pkg.number })}
                isDisabled={disabled}
                onPress={onEditItems}
              >
                {pkg.items.map((item) => (
                  <span
                    key={item.orderItemId}
                    className="inline-flex items-center gap-2"
                    role="img"
                    aria-label={t("pack.packagedItems", { count: item.quantity, name: item.name })}
                  >
                    <ItemThumb
                      url={lines.find((l) => l.id === item.orderItemId)?.imageUrl ?? null}
                      className="size-12"
                    />
                    <span className="text-xl font-bold tabular-nums">×{item.quantity}</span>
                  </span>
                ))}
              </Button>
              <LotRows items={pkg.items} />
            </div>
          )}
        </>
      )}
    </li>
  );
}

/**
 * Each lot-needing box line: **Lot needed**, or its lots as chips ("2 × A12A0124"). Scanning a lot
 * label with the package selected fills them in (SPEC-lumexia "Reads and UI").
 */
function LotRows({ items }: { items: PackageItemView[] }) {
  const t = useTranslations();
  const lotItems = items.filter((it) => it.needsLot || it.lots.length > 0);
  if (lotItems.length === 0) return null;
  return (
    <ul className="space-y-2 px-4 pb-4" data-testid="pack-lots">
      {lotItems.map((item) => (
        <li key={item.orderItemId} className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">{item.name}</span>
          {item.lots.length === 0 ? (
            <span className="badge badge-warning" data-testid="pack-lot-needed">
              {t("pack.lotNeeded")}
            </span>
          ) : (
            <ul className="flex flex-wrap gap-2" aria-label={t("pack.lotsOf", { name: item.name })}>
              {item.lots.map((lot) => {
                const label = lot.lotNumber ? lotLabel(lot.lotNumber) : (lot.lumexiaLotId ?? "");
                return (
                  <li
                    key={lot.id}
                    className="badge badge-outline badge-lg tabular-nums"
                    title={lot.lotNumber ?? undefined}
                    aria-label={t("pack.lotChipLabel", { count: lot.quantity, lot: label })}
                  >
                    {t("pack.lotChip", { count: lot.quantity, lot: label })}
                  </li>
                );
              })}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The saved weight as an icon and a number that opens for editing; the fields while there's none. */
function WeightEditor({
  pkg,
  weightDisplay,
  disabled,
  weighing,
  onWeigh,
}: {
  pkg: PackPackage;
  weightDisplay: WeightDisplay;
  disabled: boolean;
  weighing: boolean;
  onWeigh: (weightOz: number, overrideReason?: string) => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [editing, setEditing] = useState(false);
  if (pkg.weightOz !== null && !editing) {
    return (
      <Button
        className="btn-ghost btn-lg gap-2 px-2 font-bold tabular-nums"
        aria-label={t("pack.editWeight", { number: pkg.number })}
        isDisabled={disabled}
        onPress={() => setEditing(true)}
        data-testid="pack-weight"
      >
        <Weight className="size-6" aria-hidden="true" />
        {formatWeight(pkg.weightOz, weightDisplay, locale)}
      </Button>
    );
  }
  return (
    <div className="flex flex-wrap items-end gap-2">
      <WeightField
        weightOz={pkg.weightOz}
        maxWeightOz={pkg.box?.maxWeightOz ?? null}
        weightDisplay={weightDisplay}
        disabled={disabled}
        isPending={weighing}
        onSave={(oz) => onWeigh(oz)}
      />
      {editing && (
        <Button className="btn-ghost mb-0.5" onPress={() => setEditing(false)}>
          {t("pack.weightCancel")}
        </Button>
      )}
    </div>
  );
}
