"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QaPackage, QaResult, QaRow, QaView } from "@woolrus/contracts";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/fields";
import { toast } from "@/components/ui/toast";
import { useErrorMessage } from "@/lib/errors";
import { client, orpc } from "@/lib/orpc";
import { playScanSound, useScanner } from "@/lib/scanner";
import { ScanBanner, type ScanOutcome } from "../../pick/[orderId]/pick-screen";
import { money } from "./money";
import { QaDrawer } from "./qa-drawer";

// The QA screen (SPEC-qa "UI", FR-QA-01). A tap verifies a row in full and a second tap clears
// it. Taps apply at once and the server confirms them (NFR-PERF-02); writes run one at a time per
// order so they land in the order they were made.

const priorityBadge: Record<number, string> = { 1: "badge-warning", 2: "badge-error" };

/** What the server will make of a tap, so the screen can show it before the answer comes. */
function applyTap(view: QaView, rowId: string, verified: boolean): QaView {
  return {
    ...view,
    packages: view.packages.map((pkg) => ({
      ...pkg,
      rows: pkg.rows.map((row) =>
        row.id === rowId ? { ...row, verifiedQuantity: verified ? row.quantity : 0 } : row,
      ),
    })),
  };
}

export function QaScreen({
  orderId,
  userId,
  canVerify,
}: {
  orderId: string;
  userId: string | null;
  canVerify: boolean;
}) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const view = useQuery(orpc.qa.screen.queryOptions({ input: { orderId } }));

  if (view.isPending) return <p>{t("common.loading")}</p>;
  if (view.error) {
    return (
      <p role="alert" className="alert alert-error">
        {errorMessage(view.error)}
      </p>
    );
  }
  return <QaLayout view={view.data} userId={userId} canVerify={canVerify} />;
}

function QaLayout({
  view,
  userId,
  canVerify,
}: {
  view: QaView;
  userId: string | null;
  canVerify: boolean;
}) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const { order } = view;
  const viewKey = orpc.qa.screen.queryKey({ input: { orderId: order.id } });
  const writeKey = ["qaWrite", order.id];
  const purchasing = view.purchase.kind === "purchasing";
  const mayVerify =
    canVerify && order.status === "QA" && order.claim?.userId === userId && !purchasing;

  // The package a scan goes to: the card touched last, else the first with something unverified.
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const focused =
    view.packages.find((p) => p.id === focusedId) ??
    view.packages.find((p) => p.rows.some((r) => r.verifiedQuantity < r.quantity)) ??
    view.packages[0];
  const [scanned, setScanned] = useState<ScanOutcome | null>(null);

  const scan = useMutation({
    mutationKey: writeKey,
    // Same lane as taps: a scan and a tap on the same row land in the order they were made.
    scope: { id: `qa:${order.id}` },
    // The id is made with the scan, not per request, so a retried request replays it.
    mutationFn: ({ pkg, code, scanId }: { pkg: QaPackage; code: string; scanId: string }) =>
      client.qa.scan({ orderId: order.id, packageId: pkg.id, code, scanId }),
    onSuccess: async (result: QaResult, { pkg }) => {
      playScanSound(true);
      const before = new Map(pkg.rows.map((r) => [r.id, r.verifiedQuantity]));
      const row = result.packages
        .find((p) => p.id === pkg.id)
        ?.rows.find((r) => r.verifiedQuantity > (before.get(r.id) ?? 0));
      setScanned({
        ok: true,
        at: Date.now(),
        message: t("qa.scanned", {
          name: row?.name ?? "",
          verified: row?.verifiedQuantity ?? 0,
          quantity: row?.quantity ?? 0,
        }),
      });
      if (queryClient.isMutating({ mutationKey: writeKey }) > 1) return;
      await queryClient.cancelQueries({ queryKey: viewKey });
      queryClient.setQueryData<QaView>(viewKey, (v) => (v ? { ...v, ...result } : v));
    },
    onError: (error) => {
      playScanSound(false);
      setScanned({
        ok: false,
        at: Date.now(),
        message: errorMessage(error),
        amber:
          (error as { data?: { messageKey?: string } }).data?.messageKey ===
          "errors.qa.scanAlreadyVerified",
      });
    },
  });
  useScanner((code) => {
    if (!focused) return;
    scan.mutate({ pkg: focused, code, scanId: crypto.randomUUID() });
  }, mayVerify);

  const tap = useMutation({
    mutationKey: writeKey,
    // One at a time per order: a tap and its undo reach the server in the order they were made.
    scope: { id: `qa:${order.id}` },
    mutationFn: ({ row, verified }: { row: QaRow; verified: boolean }) =>
      client.qa.setVerified({
        packageItemId: row.id,
        verified,
        idempotencyKey: crypto.randomUUID(),
      }),
    onMutate: async ({ row, verified }) => {
      await queryClient.cancelQueries({ queryKey: viewKey });
      const previous = queryClient.getQueryData<QaView>(viewKey);
      if (previous) queryClient.setQueryData(viewKey, applyTap(previous, row.id, verified));
      return { previous };
    },
    onSuccess: async (result: QaResult) => {
      // Later taps are already on screen; only the last answer may replace them.
      if (queryClient.isMutating({ mutationKey: writeKey }) > 1) return;
      await queryClient.cancelQueries({ queryKey: viewKey });
      queryClient.setQueryData<QaView>(viewKey, (v) => (v ? { ...v, ...result } : v));
    },
    onError: (error, _tap, context) => {
      if (context?.previous) queryClient.setQueryData(viewKey, context.previous);
      toast.error(errorMessage(error));
      void queryClient.invalidateQueries({ queryKey: viewKey });
    },
  });

  return (
    <section className="mx-auto max-w-6xl space-y-4 pb-28">
      <QaHeader view={view} />
      <QaBanner view={view} userId={userId} />
      {view.customerNote && (
        <div className="alert alert-info">
          <span className="font-semibold">{t("order.customerNote")}:</span>
          <span className="whitespace-pre-line">{view.customerNote}</span>
        </div>
      )}
      {view.orderIssueIds.length > 0 && (
        <div role="alert" className="alert alert-error" data-testid="qa-order-critical">
          <span aria-hidden="true">⚠</span>
          {t("qa.orderCritical", { count: view.orderIssueIds.length })}
        </div>
      )}
      <PurchaseBanner purchase={view.purchase} />
      {mayVerify && <ScanBanner outcome={scanned} linkTo={[]} linking={false} onLink={() => {}} />}

      {view.packages.length === 0 ? (
        <p className="alert">{t("qa.nothingToVerify")}</p>
      ) : (
        <ul
          className="grid items-start gap-4 landscape:grid-cols-2 xl:grid-cols-2"
          aria-label={t("qa.packages")}
        >
          {view.packages.map((pkg) => (
            <PackageCard
              key={pkg.id}
              pkg={pkg}
              disabled={!mayVerify}
              isFocused={pkg.id === focused?.id}
              onFocus={() => setFocusedId(pkg.id)}
              onTap={(row) => {
                setFocusedId(pkg.id);
                tap.mutate({ row, verified: row.verifiedQuantity < row.quantity });
              }}
            />
          ))}
        </ul>
      )}

      <footer
        data-toast-clearance
        className="fixed inset-x-0 bottom-0 z-10 space-y-1 border-t border-base-300 bg-base-100 p-4"
      >
        {view.unmet.length === 0 ? (
          <p className="font-semibold" data-testid="qa-all-done">
            {t("qa.allDone")}
          </p>
        ) : (
          <>
            <p className="font-semibold">{t("qa.stillNeeded")}</p>
            <ul className="list-disc ps-6 text-sm" data-testid="qa-unmet">
              {view.unmet.map((condition) => (
                <li key={`${condition.messageKey}:${JSON.stringify(condition.params)}`}>
                  {t.has(condition.messageKey as never)
                    ? t(condition.messageKey as never, condition.params as never)
                    : t("errors.internal")}
                </li>
              ))}
            </ul>
          </>
        )}
      </footer>
    </section>
  );
}

function QaHeader({ view }: { view: QaView }) {
  const t = useTranslations();
  const { order } = view;
  const level = Math.min(order.priority, 2) as 0 | 1 | 2;
  return (
    <header className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-3xl font-bold">{t("qa.title", { number: order.number })}</h1>
        <span className={`badge badge-lg ${priorityBadge[level] ?? "badge-ghost"}`}>
          {t(`queue.priorityLevel.${level}`)}
        </span>
        <span className="ms-auto flex items-center gap-2">
          <QaDrawer view={view} />
          <Link href={`/orders/${order.id}`} className="btn btn-ghost btn-sm">
            {t("pack.orderDetails")}
          </Link>
        </span>
      </div>
      <p className="text-lg">{order.customerName}</p>
    </header>
  );
}

/** Why the screen is locked, when it is: the order left QA, or the claim isn't the viewer's. */
function QaBanner({ view, userId }: { view: QaView; userId: string | null }) {
  const t = useTranslations();
  const { order } = view;
  let message: string | null = null;
  if (order.status !== "QA") {
    message = t("qa.notInQa", { status: t(`status.${order.status}`) });
  } else if (!order.claim) {
    message = t("qa.notClaimed");
  } else if (order.claim.userId !== userId) {
    message = t("pack.claimedByOther", { name: order.claim.userName });
  }
  if (!message) return null;
  return (
    <div role="status" className="alert alert-warning" data-testid="qa-banner">
      <span className="grow">{message}</span>
      <Link href={`/orders/${order.id}`} className="btn-sm">
        {t("pack.orderDetails")}
      </Link>
    </div>
  );
}

function PurchaseBanner({ purchase }: { purchase: QaView["purchase"] }) {
  const t = useTranslations();
  if (purchase.kind === "purchasing") {
    return (
      <div role="status" className="alert alert-info" data-testid="qa-buying">
        {t("qa.buying", { bought: purchase.bought, total: purchase.total })}
      </div>
    );
  }
  if (purchase.kind === "failed") {
    return (
      <div role="alert" className="alert alert-error" data-testid="qa-failed">
        {t("qa.failedPackages", { packages: purchase.packages.map((n) => `#${n}`).join(", ") })}
      </div>
    );
  }
  return null;
}

const labelKeys = {
  PURCHASING: "qa.labelPurchasing",
  ACTIVE: "qa.labelActive",
  PURCHASE_FAILED: "qa.labelFailed",
  VOID_REQUESTED: "qa.labelVoidRequested",
  VOIDED: "qa.labelVoided",
  VOID_REJECTED: "qa.labelVoidRejected",
} as const;

function PackageCard({
  pkg,
  disabled,
  isFocused,
  onFocus,
  onTap,
}: {
  pkg: QaPackage;
  disabled: boolean;
  isFocused: boolean;
  onFocus: () => void;
  onTap: (row: QaRow) => void;
}) {
  const t = useTranslations();
  const format = useFormatter();
  const verified = pkg.rows.filter((r) => r.verifiedQuantity === r.quantity).length;
  const { label } = pkg;
  return (
    <li
      onPointerDown={onFocus}
      className={`space-y-3 rounded-box bg-base-100 p-4 shadow-sm ${isFocused ? "ring-2 ring-primary" : ""}`}
      data-testid="qa-package"
      data-package={pkg.number}
      data-focused={isFocused || undefined}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xl font-bold">
          {t("qa.package", { number: pkg.number })}
          {isFocused && <span className="badge badge-primary ms-2">{t("qa.scanningHere")}</span>}
        </h2>
        <span className="text-sm" data-testid="qa-package-count">
          {t("qa.verifiedCount", { verified, total: pkg.rows.length })}
        </span>
      </div>
      <p className="text-sm opacity-70">
        {pkg.boxName ? t("qa.box", { name: pkg.boxName }) : t("qa.customBox")}
      </p>
      <ul className="grid gap-2">
        {pkg.rows.map((row) => (
          <RowButton key={row.id} row={row} disabled={disabled} onTap={() => onTap(row)} />
        ))}
      </ul>
      {label && (
        <div className="rounded-box bg-base-200 p-3 text-sm" data-testid="qa-label">
          <div className="font-semibold">{t(labelKeys[label.status])}</div>
          {label.trackingNumber && <div>{t("qa.tracking", { number: label.trackingNumber })}</div>}
          {label.costCents !== null && label.quotedAmountCents !== null && (
            <div>
              {t("qa.cost", {
                cost: money(format, label.costCents),
                quoted: money(format, label.quotedAmountCents),
              })}
            </div>
          )}
          {label.error && t.has(label.error as never) && <div>{t(label.error as never)}</div>}
        </div>
      )}
    </li>
  );
}

function RowButton({ row, disabled, onTap }: { row: QaRow; disabled: boolean; onTap: () => void }) {
  const t = useTranslations();
  const done = row.verifiedQuantity === row.quantity;
  return (
    <li>
      <Button
        isDisabled={disabled}
        onPress={onTap}
        aria-pressed={done}
        aria-label={
          done
            ? t("qa.clearRow", { name: row.name })
            : t("qa.verifyRow", { name: row.name, quantity: row.quantity })
        }
        data-testid="qa-row"
        data-verified={done}
        className={`flex min-h-16 w-full items-center gap-3 rounded-box border-2 p-3 text-start ${
          done ? "border-success bg-success/10" : "border-base-300 bg-base-100"
        } ${row.criticalIssueId ? "ring-2 ring-error" : ""}`}
      >
        {row.imageUrl ? (
          // biome-ignore lint/performance/noImgElement: store-hosted thumbnail, sized by the card
          <img src={row.imageUrl} alt="" className="size-12 shrink-0 rounded object-cover" />
        ) : null}
        <span className="grow">
          <span className="block font-semibold">{row.name}</span>
          {row.sku && (
            <span className="block text-sm opacity-70">{t("qa.sku", { sku: row.sku })}</span>
          )}
          {row.attributes.length > 0 && (
            <span className="block text-sm opacity-70">
              {row.attributes.map((a) => `${a.name}: ${a.option}`).join(" · ")}
            </span>
          )}
          {row.criticalIssueId && (
            <span className="badge badge-error mt-1 gap-1" data-testid="qa-critical">
              <span aria-hidden="true">⚠</span>
              {t("qa.criticalIssue")}
            </span>
          )}
        </span>
        <span className="shrink-0 text-end">
          <span className="block text-lg font-bold" data-testid="qa-row-progress">
            {t("qa.unitsProgress", { verified: row.verifiedQuantity, quantity: row.quantity })}
          </span>
          <span className="block text-sm">
            <span aria-hidden="true">{done ? "✓ " : ""}</span>
            {done ? t("qa.rowVerified") : t("qa.rowNotVerified")}
          </span>
        </span>
      </Button>
    </li>
  );
}
