"use client";

import { ORPCError } from "@orpc/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PickLine, PickLineResult, PickStatus, PickView } from "@woolrus/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useState } from "react";
import { ToggleButton } from "react-aria-components";
import { Button } from "@/components/ui/fields";
import { toast } from "@/components/ui/toast";
import { useErrorMessage } from "@/lib/errors";
import { client, orpc } from "@/lib/orpc";
import { playScanSound, useScanner } from "@/lib/scanner";
import { type Unmet, UnmetList, unmetOf } from "../../orders/[id]/order-actions";
import { LineMenu } from "./line-dialogs";

// The pick screen (SPEC-picking "UI", FR-PICK-01/02). Taps apply at once and the server confirms
// them (NFR-PERF-02); writes run one at a time per order so they land in the order they were made.

const priorityBadge: Record<number, string> = { 1: "badge-warning", 2: "badge-error" };

const isDone = (status: PickStatus) => status === "PICKED" || status === "SUBSTITUTED";

/** A line write: `quantity` 0 puts the line back to not picked. */
type Write = { line: PickLine; quantity: number };

/** What the server will make of a write, so the screen can show it before the answer comes. */
function applyWrite(view: PickView, { line, quantity }: Write): PickView {
  const lines = view.lines.map((l) =>
    l.id === line.id
      ? {
          ...l,
          pickedQuantity: quantity,
          pickStatus: (quantity === l.quantity ? "PICKED" : "PENDING") as PickStatus,
          substitutionNote: null,
        }
      : l,
  );
  return { ...view, lines, done: lines.filter((l) => isDone(l.pickStatus)).length };
}

/**
 * What the last scan did, for the banner: counted on a line, or refused with the reason. `linkCode`
 * is an unknown code the viewer may link to a line's product (SPEC-picking "Code matching").
 */
export type ScanOutcome = {
  ok: boolean;
  message: string;
  lineId?: string;
  linkCode?: string;
  at: number;
};

/** True when the server offered to link a refused scan's unknown code to a product. */
export const canLinkOf = (error: unknown) =>
  error instanceof ORPCError && (error.data as { canLink?: boolean } | undefined)?.canLink === true;

function applyResult(view: PickView, result: PickLineResult): PickView {
  const lines = view.lines.map((l) => (l.id === result.line.id ? result.line : l));
  return { ...view, lines, done: result.done, total: result.total };
}

type Viewer = { userId: string | null; canPack: boolean };

export function PickScreen({ orderId, ...viewer }: { orderId: string } & Viewer) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const view = useQuery(orpc.picking.view.queryOptions({ input: { orderId } }));

  if (view.isPending) return <p>{t("common.loading")}</p>;
  if (view.error) {
    return (
      <p role="alert" className="alert alert-error">
        {errorMessage(view.error)}
      </p>
    );
  }
  return <PickLayout view={view.data} {...viewer} />;
}

/** Where the picker goes once the order is picked (SPEC-picking decision 6). */
type Then = "queue" | "next" | "pack";

function PickLayout({ view, userId, canPack }: { view: PickView } & Viewer) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [unmet, setUnmet] = useState<Unmet[] | null>(null);
  const { order } = view;
  const viewKey = orpc.picking.view.queryKey({ input: { orderId: order.id } });
  const writeKey = ["pickWrite", order.id];
  const writeScope = `pick:${order.id}`;
  const canPick = order.status === "PICKING" && order.claim?.userId === userId;

  const write = useMutation({
    mutationKey: writeKey,
    // One at a time per order: a tap and its undo reach the server in the order they were made.
    scope: { id: writeScope },
    mutationFn: ({ line, quantity }: Write) =>
      quantity === 0
        ? client.picking.unpickLine({ itemId: line.id })
        : client.picking.pickLine({ itemId: line.id, quantity }),
    onMutate: async (w) => {
      setUnmet(null);
      await queryClient.cancelQueries({ queryKey: viewKey });
      const previous = queryClient.getQueryData<PickView>(viewKey);
      if (previous) queryClient.setQueryData(viewKey, applyWrite(previous, w));
      return { previous };
    },
    onSuccess: (result) => {
      // Later taps are already on screen; only the last answer may replace them.
      if (queryClient.isMutating({ mutationKey: writeKey }) > 1) return;
      queryClient.setQueryData<PickView>(viewKey, (v) => (v ? applyResult(v, result) : v));
    },
    onError: (error, _w, context) => {
      if (context?.previous) queryClient.setQueryData(viewKey, context.previous);
      toast.error(errorMessage(error));
      void queryClient.invalidateQueries({ queryKey: viewKey });
    },
  });

  const [scanned, setScanned] = useState<ScanOutcome | null>(null);
  const scan = useMutation({
    // Same lane as taps: a scan and a tap on the same line land in the order they were made.
    scope: { id: `pick:${order.id}` },
    mutationFn: (code: string) =>
      client.picking.scan({ orderId: order.id, code, scanId: crypto.randomUUID() }),
    onSuccess: (result) => {
      queryClient.setQueryData<PickView>(viewKey, (v) => (v ? applyResult(v, result) : v));
      playScanSound(true);
      setScanned({
        ok: true,
        lineId: result.line.id,
        at: Date.now(),
        message: t("pick.scanned", {
          name: result.line.name,
          picked: result.line.pickedQuantity,
          quantity: result.line.quantity,
        }),
      });
    },
    onError: (error, code) => {
      playScanSound(false);
      setScanned({
        ok: false,
        at: Date.now(),
        message: errorMessage(error),
        linkCode: canLinkOf(error) ? code : undefined,
      });
    },
  });
  useScanner((code) => scan.mutate(code), canPick);

  const link = useMutation({
    mutationFn: ({ line, code }: { line: PickLine; code: string }) =>
      client.picking.linkBarcode({ orderItemId: line.id, code }),
    onSuccess: (result) => {
      // Nothing was counted: the next scan of the code is.
      setScanned({
        ok: true,
        at: Date.now(),
        message: t("pick.linked", { code: result.barcode, name: result.name }),
      });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  // An unknown code can go on any line still to pick; usually there's one.
  const linkable = view.lines.filter((l) => l.pickStatus === "PENDING");

  const complete = useMutation({
    mutationFn: (after: Then) =>
      client.picking.complete({ orderId: order.id, expectedVersion: order.version, after }),
    onMutate: () => setUnmet(null),
    onSuccess: ({ nextOrderId }, after) => {
      toast.success(t("order.moved", { number: order.number, status: t("status.PACKING") }));
      // The packing screen doesn't exist yet: the order detail page stands in for it.
      if (after === "pack") router.push(`/orders/${order.id}`);
      else if (nextOrderId) router.push(`/pick/${nextOrderId}`);
      else {
        if (after === "next") toast.success(t("pick.noneLeft"));
        router.push("/queue/pending");
      }
    },
    onError: (error) => {
      const missing = unmetOf(error);
      if (missing) setUnmet(missing);
      else toast.error(errorMessage(error));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: orpc.orders.key() }),
  });

  // Done lines drop below the rest; otherwise the server's pick order stands (sort is stable).
  const lines = [...view.lines].sort(
    (a, b) => Number(isDone(a.pickStatus)) - Number(isDone(b.pickStatus)),
  );

  return (
    <section className="mx-auto max-w-5xl space-y-4 pb-28">
      <PickHeader view={view} />
      <PickBanner view={view} userId={userId} />
      <ScanBanner
        outcome={scanned}
        linkTo={scanned?.linkCode ? linkable : []}
        linking={link.isPending}
        onLink={(line) => scanned?.linkCode && link.mutate({ line, code: scanned.linkCode })}
      />

      {view.customerNote && (
        <div className="alert alert-info">
          <span className="font-semibold">{t("order.customerNote")}:</span>
          <span className="whitespace-pre-line">{view.customerNote}</span>
        </div>
      )}

      {view.total === 0 ? (
        <p className="alert">{t("pick.nothingToPick")}</p>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2" aria-label={t("pick.lines")}>
          {lines.map((line) => (
            <PickCard
              key={line.id}
              line={line}
              disabled={!canPick}
              flash={scanned?.ok && scanned.lineId === line.id ? scanned.at : null}
              onWrite={(quantity) => write.mutate({ line, quantity })}
              menu={
                <LineMenu
                  line={line}
                  disabled={!canPick}
                  scope={writeScope}
                  onResult={(result) => {
                    setUnmet(null);
                    queryClient.setQueryData<PickView>(viewKey, (v) =>
                      v ? applyResult(v, result) : v,
                    );
                  }}
                />
              }
            />
          ))}
        </ul>
      )}
      {view.voidedLines > 0 && (
        <p className="text-sm opacity-70">{t("pick.voidedLines", { count: view.voidedLines })}</p>
      )}

      {unmet && <UnmetList unmet={unmet} />}

      {canPick && (
        <footer
          data-toast-clearance
          className="fixed inset-x-0 bottom-0 z-10 flex justify-end gap-2 border-t border-base-300 bg-base-100 p-4"
        >
          <Button
            className="btn-outline btn-lg"
            isDisabled={complete.isPending}
            onPress={() => complete.mutate("queue")}
          >
            {t("pick.done")}
          </Button>
          {canPack && (
            <Button
              className="btn-outline btn-lg"
              isDisabled={complete.isPending}
              onPress={() => complete.mutate("pack")}
            >
              {t("pick.donePack")}
            </Button>
          )}
          <Button
            className="btn-primary btn-lg"
            isDisabled={complete.isPending}
            onPress={() => complete.mutate("next")}
          >
            {t("pick.doneNext")}
          </Button>
        </footer>
      )}
    </section>
  );
}

function PickHeader({ view }: { view: PickView }) {
  const t = useTranslations();
  const { order } = view;
  const level = Math.min(order.priority, 2) as 0 | 1 | 2;
  return (
    <header className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-3xl font-bold">{t("pick.title", { number: order.number })}</h1>
        <span className={`badge badge-lg ${priorityBadge[level] ?? "badge-ghost"}`}>
          {t(`queue.priorityLevel.${level}`)}
        </span>
        <Link href={`/orders/${order.id}`} className="btn btn-ghost btn-sm ms-auto">
          {t("pick.orderDetails")}
        </Link>
      </div>
      <p className="text-lg">{order.customerName}</p>
      <div className="flex items-center gap-3">
        <progress
          className="progress progress-success w-full max-w-md"
          value={view.done}
          max={Math.max(view.total, 1)}
          aria-label={t("pick.progressLabel")}
        />
        <span className="tabular-nums" data-testid="pick-progress">
          {t("pick.progress", { done: view.done, total: view.total })}
        </span>
      </div>
    </header>
  );
}

/** Why the cards are locked, when they are: the order left Picking, or the claim isn't the viewer's. */
function PickBanner({ view, userId }: { view: PickView; userId: string | null }) {
  const t = useTranslations();
  const { order } = view;
  let message: string | null = null;
  if (order.status !== "PICKING") {
    message = t("pick.notPicking", { status: t(`status.${order.status}`) });
  } else if (!order.claim) {
    message = t("pick.unclaimed");
  } else if (order.claim.userId !== userId) {
    message = t("pick.claimedByOther", { name: order.claim.userName });
  }
  if (!message) return null;
  return (
    <div role="status" className="alert alert-warning">
      <span className="grow">{message}</span>
      <Link href={`/orders/${order.id}`} className="btn-sm">
        {t("pick.orderDetails")}
      </Link>
    </div>
  );
}

/**
 * The last scan's result, announced to screen readers (NFR-UX-05). The live region stays mounted so
 * every new message is read out; the banner itself shows only once something was scanned.
 */
export function ScanBanner({
  outcome,
  linkTo,
  linking,
  onLink,
}: {
  outcome: ScanOutcome | null;
  /** Lines the refused code may be linked to; empty when there's nothing to offer. */
  linkTo: PickLine[];
  linking: boolean;
  onLink: (line: PickLine) => void;
}) {
  const t = useTranslations();
  return (
    <div aria-live="assertive" aria-atomic="true">
      {outcome && (
        <div
          key={outcome.at}
          className={`alert ${outcome.ok ? "alert-success" : "alert-error"} text-lg font-semibold`}
          data-testid="scan-banner"
          data-ok={outcome.ok}
        >
          <span aria-hidden="true">{outcome.ok ? "✓" : "✕"}</span>
          <span>
            <span className="sr-only">
              {outcome.ok ? t("pick.scanOk") : t("pick.scanRefused")}{" "}
            </span>
            {outcome.message}
          </span>
          {linkTo.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {linkTo.map((line) => (
                <Button
                  key={line.id}
                  className="btn-sm"
                  isDisabled={linking}
                  onPress={() => onLink(line)}
                >
                  {t("pick.linkCode", { name: line.name })}
                </Button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** True for a second after `at`: long enough to see which card a scan counted on. */
function useFlash(at: number | null) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (at === null) return;
    setOn(true);
    const timer = setTimeout(() => setOn(false), 1000);
    return () => clearTimeout(timer);
  }, [at]);
  return on;
}

const statusIcon: Record<PickStatus, string> = {
  PENDING: "○",
  PICKED: "✓",
  OUT_OF_STOCK: "⚠",
  SUBSTITUTED: "⇄",
};

const statusTone: Record<PickStatus, string> = {
  PENDING: "border-base-300",
  PICKED: "border-success bg-success/10",
  OUT_OF_STOCK: "border-error bg-error/10",
  SUBSTITUTED: "border-info bg-info/10",
};

function PickCard({
  line,
  disabled,
  flash,
  onWrite,
  menu,
}: {
  line: PickLine;
  disabled: boolean;
  /** When a scan last counted on this card. */
  flash: number | null;
  onWrite: (quantity: number) => void;
  /** Out of Stock and Substituted; absent while the viewer can't pick. */
  menu: ReactNode;
}) {
  const t = useTranslations();
  const flashing = useFlash(flash);
  const done = isDone(line.pickStatus);
  const partial = line.pickStatus === "PENDING" && line.pickedQuantity > 0;
  const statusText = partial ? t("pick.partial") : t(`order.pickStatus.${line.pickStatus}`);

  return (
    <li
      className={`rounded-box border-2 bg-base-100 shadow-sm transition-shadow ${statusTone[line.pickStatus]} ${flashing ? "ring-4 ring-success" : ""}`}
      data-testid="pick-card"
      data-flash={flashing || undefined}
    >
      <ToggleButton
        isSelected={done}
        isDisabled={disabled}
        // Tap: pick it all, or undo a pick (FR-PICK-02).
        onChange={() => onWrite(done ? 0 : line.quantity)}
        className="flex min-h-40 w-full cursor-pointer items-start gap-4 rounded-box p-4 text-start outline-offset-2 focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed"
      >
        {line.imageUrl ? (
          // Store images come from the shop's own domain; next/image would need it configured.
          // biome-ignore lint/performance/noImgElement: see above
          <img src={line.imageUrl} alt="" className="size-24 shrink-0 rounded-box object-cover" />
        ) : (
          <div className="size-24 shrink-0 rounded-box bg-base-200" aria-hidden="true" />
        )}
        <div className="min-w-0 grow space-y-1">
          <div className="text-xl font-bold">{line.name}</div>
          {line.sku && <div className="text-sm">{t("pick.sku", { sku: line.sku })}</div>}
          {line.attributes.length > 0 && (
            // Size, pack and checkout options, as the store names them (store data, not UI text).
            <dl className="space-y-0.5 text-sm">
              {line.attributes.map((a, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: names can repeat; order is fixed
                <div key={i}>
                  <dt className="inline text-base-content/70">{a.name}:</dt>{" "}
                  <dd className="inline font-medium">{a.option}</dd>
                </div>
              ))}
            </dl>
          )}
          {line.binLocation && (
            <div className="badge badge-outline">{t("pick.bin", { bin: line.binLocation })}</div>
          )}
          {line.substitutionNote && <div className="text-sm">{line.substitutionNote}</div>}
        </div>
        <div className="shrink-0 text-end">
          <div className="text-4xl font-bold tabular-nums">
            {t("pick.count", { picked: line.pickedQuantity, quantity: line.quantity })}
          </div>
          <div className="mt-1 font-semibold" data-testid="pick-status">
            <span aria-hidden="true">{partial ? "◐" : statusIcon[line.pickStatus]}</span>{" "}
            {statusText}
          </div>
        </div>
      </ToggleButton>
      {(line.quantity > 1 || !disabled) && (
        <div className="flex justify-end gap-2 border-t border-base-300 p-2">
          {menu}
          {line.quantity > 1 && (
            <>
              <Button
                className="btn-outline btn-lg min-w-20 text-2xl"
                aria-label={t("pick.oneFewer", { name: line.name })}
                isDisabled={disabled || line.pickedQuantity === 0}
                onPress={() => onWrite(line.pickedQuantity - 1)}
              >
                −
              </Button>
              <Button
                className="btn-outline btn-lg min-w-20 text-2xl"
                aria-label={t("pick.oneMore", { name: line.name })}
                isDisabled={disabled || line.pickedQuantity >= line.quantity}
                onPress={() => onWrite(line.pickedQuantity + 1)}
              >
                +
              </Button>
            </>
          )}
        </div>
      )}
    </li>
  );
}
