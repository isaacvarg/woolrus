"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  PickBatch,
  PickBatchChip,
  PickBatchGroup,
  PickLine,
  PickLineResult,
  PickStatus,
  ScanBatchResult,
} from "@woolrus/contracts";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ToggleButton } from "react-aria-components";
import { toast } from "@/components/ui/toast";
import { useErrorMessage } from "@/lib/errors";
import { client, orpc } from "@/lib/orpc";
import { playScanSound, useScanner } from "@/lib/scanner";
import { LineMenu } from "../../[orderId]/line-dialogs";
import { canLinkOf, ScanBanner, type ScanOutcome } from "../../[orderId]/pick-screen";
import { SlotLegend } from "../../slot-legend";
import { BatchFooter, CompletionResults, SlotActions, useBatchActions } from "./batch-actions";

// The batch screen (SPEC-picking "UI", FR-PICK-05): the pick list for the whole walk, one card per
// product with a chip per slot, and the slot legend. Chips act on their order's line with the same
// operations as the single-order screen, in the same per-order write lane. Members that leave drop
// out live: every order event refetches the batch. A scan fills the first slot that still needs the
// product, and a large callout says which slot to drop it in.

const isDone = (status: PickStatus) => status === "PICKED" || status === "SUBSTITUTED";

/** The batch with one line replaced, and its group's count left recomputed. */
function withLine(batch: PickBatch, line: PickLine): PickBatch {
  const groups = batch.groups.map((group) => {
    if (!group.chips.some((c) => c.line.id === line.id)) return group;
    const chips = group.chips.map((c) => (c.line.id === line.id ? { ...c, line } : c));
    const remaining = chips.reduce(
      (sum, c) => sum + (isDone(c.line.pickStatus) ? 0 : c.line.quantity - c.line.pickedQuantity),
      0,
    );
    return { ...group, chips, remaining };
  });
  return { ...batch, groups };
}

type Viewer = { userId: string | null; canPick: boolean };

/** The last scan's outcome; a counted one carries the slot it filled, for the callout. */
type BatchScan = ScanOutcome & { slot?: ScanBatchResult; name?: string };

export function BatchScreen({ batchId, userId, canPick }: { batchId: string } & Viewer) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const batch = useQuery(orpc.pickBatches.get.queryOptions({ input: { id: batchId } }));
  const canAct =
    canPick && batch.data?.owner.id === userId && batch.data !== undefined && !batch.data.closedAt;

  const [scanned, setScanned] = useState<BatchScan | null>(null);
  const scan = useMutation({
    // One lane for the batch's scans: each one counts against what the one before left.
    scope: { id: `pickBatch:${batchId}` },
    // The key is made with the scan, not per request, so a retried request replays it.
    mutationFn: ({ code, scanId }: { code: string; scanId: string }) =>
      client.pickBatches.scan({ batchId, code, scanId }),
    onSuccess: (result) => {
      playScanSound(true);
      const name = batch.data?.groups
        .flatMap((g) => g.chips)
        .find((c) => c.line.id === result.itemId)?.line.name;
      setScanned({
        ok: true,
        at: Date.now(),
        message: "",
        slot: result,
        name,
        lineId: result.itemId,
      });
      void queryClient.invalidateQueries({
        queryKey: orpc.pickBatches.get.queryKey({ input: { id: batchId } }),
      });
    },
    onError: (error, { code }) => {
      playScanSound(false);
      setScanned({
        ok: false,
        at: Date.now(),
        message: errorMessage(error),
        linkCode: canLinkOf(error) ? code : undefined,
      });
    },
  });
  useScanner((code) => scan.mutate({ code, scanId: crypto.randomUUID() }), canAct);

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

  if (batch.isPending) return <p>{t("common.loading")}</p>;
  if (batch.error) {
    return (
      <p role="alert" className="alert alert-error">
        {errorMessage(batch.error)}
      </p>
    );
  }
  return (
    <BatchView
      data={batch.data}
      userId={userId}
      canAct={canAct}
      scanned={scanned}
      linking={link.isPending}
      onLink={(line, code) => link.mutate({ line, code })}
    />
  );
}

function BatchView({
  data,
  userId,
  canAct,
  scanned,
  linking,
  onLink,
}: {
  data: PickBatch;
  userId: string | null;
  canAct: boolean;
  scanned: BatchScan | null;
  linking: boolean;
  onLink: (line: PickLine, code: string) => void;
}) {
  const t = useTranslations();
  const actions = useBatchActions(data);
  const mine = data.owner.id === userId;
  // An unknown code can go on any product still to pick: one line of each stands for it.
  const linkable = data.groups
    .filter((g) => g.remaining > 0)
    .map((g) => (g.chips[0] as PickBatchChip).line);
  return (
    <section className={`mx-auto max-w-5xl space-y-4 ${canAct ? "pb-28" : ""}`}>
      <header className="space-y-1">
        <h1 className="text-3xl font-bold">{t("pickBatch.title", { number: data.number })}</h1>
        <p className="text-lg">
          {t("pickBatch.summary", {
            name: data.owner.name,
            live: data.members.filter((m) => m.state === "live").length,
            total: data.members.length,
          })}
        </p>
      </header>
      {data.closedAt ? (
        <p className="alert">{t("pickBatch.closed")}</p>
      ) : (
        !mine && (
          <p role="status" className="alert alert-warning">
            {t("pickBatch.readOnly", { name: data.owner.name })}
          </p>
        )
      )}

      {scanned?.slot ? (
        <SlotCallout key={scanned.at} result={scanned.slot} name={scanned.name} />
      ) : (
        <ScanBanner
          outcome={scanned}
          linkTo={scanned?.linkCode ? linkable : []}
          linking={linking}
          onLink={(line) => scanned?.linkCode && onLink(line, scanned.linkCode)}
        />
      )}

      {data.closedAt === null && (
        <>
          <h2 className="text-xl font-semibold">{t("pickBatch.list")}</h2>
          {data.groups.length === 0 ? (
            <p className="alert">{t("pickBatch.nothingToPick")}</p>
          ) : (
            <ul className="space-y-4" aria-label={t("pickBatch.list")}>
              {data.groups.map((group) => (
                <GroupCard
                  key={group.key}
                  batchId={data.id}
                  group={group}
                  canAct={canAct}
                  lastScanned={scanned?.slot?.itemId}
                />
              ))}
            </ul>
          )}
        </>
      )}

      <CompletionResults actions={actions} />

      <h2 className="text-xl font-semibold">{t("pickBatch.slots")}</h2>
      <SlotLegend
        batch={data}
        actions={canAct ? (member) => <SlotActions member={member} actions={actions} /> : undefined}
      />
      {canAct && <BatchFooter batch={data} actions={actions} />}
    </section>
  );
}

/** Where the scanned unit goes on the cart, large enough to read from the shelf. */
function SlotCallout({ result, name }: { result: ScanBatchResult; name?: string }) {
  const t = useTranslations();
  return (
    <div aria-live="assertive" aria-atomic="true">
      <div
        className="alert alert-success flex-col items-start gap-1"
        data-testid="slot-callout"
        data-slot={result.slot}
      >
        <span className="sr-only">{t("pick.scanOk")} </span>
        <span className="text-5xl font-bold tabular-nums">
          {t("pickBatch.callout", { slot: result.slot, number: result.number })}
        </span>
        {name && <span className="text-lg font-semibold">{name}</span>}
      </div>
    </div>
  );
}

function GroupCard({
  batchId,
  group,
  canAct,
  lastScanned,
}: {
  batchId: string;
  group: PickBatchGroup;
  canAct: boolean;
  /** The line the last scan counted on, ringed so the picker sees which chip moved. */
  lastScanned?: string;
}) {
  const t = useTranslations();
  const finished = group.remaining === 0;
  return (
    <li
      className={`rounded-box border-2 bg-base-100 p-4 shadow-sm ${finished ? "border-success bg-success/10" : "border-base-300"}`}
      data-testid="batch-group"
    >
      <div className="flex items-start gap-4">
        {group.imageUrl ? (
          // Store images come from the shop's own domain; next/image would need it configured.
          // biome-ignore lint/performance/noImgElement: see above
          <img src={group.imageUrl} alt="" className="size-24 shrink-0 rounded-box object-cover" />
        ) : (
          <div className="size-24 shrink-0 rounded-box bg-base-200" aria-hidden="true" />
        )}
        <div className="min-w-0 grow space-y-1">
          <h3 className="text-xl font-bold">{group.name}</h3>
          {group.sku && <div className="text-sm">{t("pick.sku", { sku: group.sku })}</div>}
          {group.attributes && <Attributes attributes={group.attributes} />}
          {group.binLocation && (
            <div className="badge badge-outline">{t("pick.bin", { bin: group.binLocation })}</div>
          )}
        </div>
        <div className="shrink-0 text-end text-3xl font-bold tabular-nums" data-testid="group-left">
          {t("pickBatch.remaining", { remaining: group.remaining, quantity: group.quantity })}
        </div>
      </div>
      <ul className="mt-3 flex flex-wrap gap-2" aria-label={group.name}>
        {group.chips.map((chip) => (
          <Chip
            key={chip.line.id}
            batchId={batchId}
            chip={chip}
            showAttributes={group.attributes === null}
            canAct={canAct}
            scanned={chip.line.id === lastScanned}
          />
        ))}
      </ul>
    </li>
  );
}

function Attributes({ attributes }: { attributes: PickLine["attributes"] }) {
  if (attributes.length === 0) return null;
  return (
    // Size, pack and checkout options, as the store names them (store data, not UI text).
    <dl className="space-y-0.5 text-sm">
      {attributes.map((a, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: names can repeat; order is fixed
        <div key={i}>
          <dt className="inline text-base-content/70">{a.name}:</dt>{" "}
          <dd className="inline font-medium">{a.option}</dd>
        </div>
      ))}
    </dl>
  );
}

const statusIcon: Record<PickStatus, string> = {
  PENDING: "○",
  PICKED: "✓",
  OUT_OF_STOCK: "⚠",
  SUBSTITUTED: "⇄",
};

const statusTone: Record<PickStatus, string> = {
  PENDING: "border-base-300",
  PICKED: "border-success bg-success/10 opacity-70",
  OUT_OF_STOCK: "border-error bg-error/10",
  SUBSTITUTED: "border-info bg-info/10 opacity-70",
};

/** One slot's share of a product: tap picks it all or puts it back, the menu does the rest. */
function Chip({
  batchId,
  chip,
  showAttributes,
  canAct,
  scanned,
}: {
  batchId: string;
  chip: PickBatchChip;
  showAttributes: boolean;
  canAct: boolean;
  scanned: boolean;
}) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const { line } = chip;
  const batchKey = orpc.pickBatches.get.queryKey({ input: { id: batchId } });
  // The single-order screen's key and lane: writes to one order land in the order they were made.
  const writeKey = ["pickWrite", chip.orderId];
  const scope = `pick:${chip.orderId}`;
  const apply = (result: PickLineResult) =>
    queryClient.setQueryData<PickBatch>(batchKey, (b) => (b ? withLine(b, result.line) : b));

  const write = useMutation({
    mutationKey: writeKey,
    scope: { id: scope },
    mutationFn: (quantity: number) =>
      quantity === 0
        ? client.picking.unpickLine({ itemId: line.id })
        : client.picking.pickLine({ itemId: line.id, quantity }),
    onMutate: async (quantity) => {
      await queryClient.cancelQueries({ queryKey: batchKey });
      const previous = queryClient.getQueryData<PickBatch>(batchKey);
      if (previous) {
        const status: PickStatus = quantity === line.quantity ? "PICKED" : "PENDING";
        queryClient.setQueryData(
          batchKey,
          withLine(previous, {
            ...line,
            pickedQuantity: quantity,
            pickStatus: status,
            substitutionNote: null,
          }),
        );
      }
      return { previous };
    },
    onSuccess: (result) => {
      // Later taps on this order are already on screen; only the last answer may replace them.
      if (queryClient.isMutating({ mutationKey: writeKey }) > 1) return;
      apply(result);
    },
    onError: (error, _quantity, context) => {
      if (context?.previous) queryClient.setQueryData(batchKey, context.previous);
      toast.error(errorMessage(error));
      void queryClient.invalidateQueries({ queryKey: batchKey });
    },
  });

  const done = isDone(line.pickStatus);
  const partial = line.pickStatus === "PENDING" && line.pickedQuantity > 0;
  const statusText = partial ? t("pick.partial") : t(`order.pickStatus.${line.pickStatus}`);
  return (
    <li
      className={`flex items-stretch rounded-box border-2 ${statusTone[line.pickStatus]} ${scanned ? "ring-4 ring-success" : ""}`}
      data-testid={`chip-${chip.slot}`}
      data-scanned={scanned || undefined}
      data-status={line.pickStatus}
    >
      <ToggleButton
        isSelected={done}
        isDisabled={!canAct}
        onChange={() => write.mutate(done ? 0 : line.quantity)}
        aria-label={t("pickBatch.chip", {
          slot: chip.slot,
          number: chip.number,
          picked: line.pickedQuantity,
          quantity: line.quantity,
          status: statusText,
        })}
        className="flex min-h-16 min-w-32 cursor-pointer items-center gap-3 rounded-box px-3 py-2 text-start outline-offset-2 focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed"
      >
        <span className="text-3xl font-bold tabular-nums">{chip.slot}</span>
        <span className="space-y-0.5">
          <span className="block text-sm font-semibold">#{chip.number}</span>
          <span className="block text-lg font-bold tabular-nums">
            {t("pick.count", { picked: line.pickedQuantity, quantity: line.quantity })}
          </span>
          {showAttributes && <Attributes attributes={line.attributes} />}
          {line.substitutionNote && <span className="block text-sm">{line.substitutionNote}</span>}
          <span className="block text-sm font-semibold">
            <span aria-hidden="true">{partial ? "◐" : statusIcon[line.pickStatus]}</span>{" "}
            {statusText}
          </span>
        </span>
      </ToggleButton>
      <LineMenu line={line} disabled={!canAct} scope={scope} quantity onResult={apply} />
    </li>
  );
}
