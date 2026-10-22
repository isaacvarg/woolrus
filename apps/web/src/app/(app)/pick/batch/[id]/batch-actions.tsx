"use client";

import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import type { PickBatch, PickBatchCompletion, PickBatchMember } from "@woolrus/contracts";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/fields";
import { toast } from "@/components/ui/toast";
import { useErrorMessage } from "@/lib/errors";
import { client, orpc } from "@/lib/orpc";
import { UnmetList } from "../../../orders/[id]/order-actions";

// Completing, removing and finishing a batch (SPEC-picking "Pick batches", #62). Each order moves on
// its own: the server answers per order, and the screen lists what moved and what each refused order
// still needs.

const isDone = (line: PickBatch["groups"][number]["chips"][number]["line"]) =>
  (line.pickStatus === "PICKED" || line.pickStatus === "SUBSTITUTED") &&
  line.pickedQuantity === line.quantity;

/** Live members whose every line is picked: the ones **Complete ready orders** sends. */
export function readyMembers(batch: PickBatch): PickBatchMember[] {
  const unfinished = new Set(
    batch.groups.flatMap((g) => g.chips.filter((c) => !isDone(c.line)).map((c) => c.orderId)),
  );
  return batch.members.filter((m) => m.state === "live" && !unfinished.has(m.orderId));
}

export function useBatchActions(batch: PickBatch) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [results, setResults] = useState<PickBatchCompletion[]>([]);
  const batchKey = orpc.pickBatches.get.queryKey({ input: { id: batch.id } });
  const show = (next: PickBatch) => {
    queryClient.setQueryData(batchKey, next);
    void queryClient.invalidateQueries({ queryKey: orpc.picking.myPicks.key() });
  };
  const numberOf = (orderId: string) =>
    batch.members.find((m) => m.orderId === orderId)?.number ?? "";
  // Batch writes and the chips' line writes don't share a lane, and completing reads the lines the
  // server already has. So Complete waits while a chip tap is still saving: "ready" is worked out
  // from the screen, which shows the tap before the server has it.
  const scope = { id: `pickBatch:${batch.id}` };
  const saving = useIsMutating({ mutationKey: ["pickWrite"] }) > 0;

  const complete = useMutation({
    scope,
    mutationFn: (members: PickBatchMember[]) =>
      client.pickBatches.complete({
        id: batch.id,
        orders: members.map((m) => ({ id: m.orderId, expectedVersion: m.version })),
      }),
    onSuccess: ({ results: next, batch: after }) => {
      setResults(next);
      show(after);
      const moved = next.filter((r) => r.moved).length;
      if (moved > 0) toast.success(t("pickBatch.moved", { count: moved }));
      if (moved < next.length) toast.error(t("pickBatch.notAllMoved"));
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const remove = useMutation({
    scope,
    mutationFn: (member: PickBatchMember) =>
      client.pickBatches.removeOrder({ id: batch.id, orderId: member.orderId }),
    onSuccess: (after, member) => {
      show(after);
      toast.success(t("pickBatch.removedOrder", { number: member.number }));
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const finish = useMutation({
    scope,
    mutationFn: () => client.pickBatches.finish({ id: batch.id }),
    onSuccess: (after) => {
      show(after);
      toast.success(t("pickBatch.finished", { number: after.number }));
      router.push("/pick");
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const busy = complete.isPending || remove.isPending || finish.isPending;
  return { complete, remove, finish, results, numberOf, busy, canComplete: !busy && !saving };
}

export type BatchActions = ReturnType<typeof useBatchActions>;

/** Per-slot **Complete** and **Remove** in the slot legend, for live members. */
export function SlotActions({
  member,
  actions,
}: {
  member: PickBatchMember;
  actions: BatchActions;
}) {
  const t = useTranslations();
  if (member.state !== "live") return null;
  const label = { slot: member.slot, number: member.number };
  return (
    <div className="flex justify-end gap-2">
      <Button
        className="btn-outline"
        isDisabled={!actions.canComplete}
        aria-label={t("pickBatch.completeSlot", label)}
        onPress={() => actions.complete.mutate([member])}
      >
        {t("pickBatch.complete")}
      </Button>
      <Button
        className="btn-ghost"
        isDisabled={actions.busy}
        aria-label={t("pickBatch.removeSlot", label)}
        onPress={() => actions.remove.mutate(member)}
      >
        {t("pickBatch.remove")}
      </Button>
    </div>
  );
}

/** What the last completion did, order by order. */
export function CompletionResults({ actions }: { actions: BatchActions }) {
  const t = useTranslations();
  if (actions.results.length === 0) return null;
  const moved = actions.results.filter((r) => r.moved);
  return (
    <section className="space-y-2" aria-label={t("pickBatch.results")} data-testid="batch-results">
      {moved.length > 0 && (
        <p role="status" className="alert alert-success">
          {t("pickBatch.movedOrders", {
            numbers: moved.map((r) => `#${actions.numberOf(r.orderId)}`).join(", "),
          })}
        </p>
      )}
      {actions.results.map((r) =>
        r.moved ? null : (
          <div key={r.orderId} className="space-y-1">
            <p className="font-semibold">
              {t("pickBatch.notMoved", { number: actions.numberOf(r.orderId) })}
            </p>
            {r.unmet.length > 0 ? (
              <UnmetList unmet={r.unmet} />
            ) : (
              <p role="alert" className="alert alert-error">
                {t.has(r.messageKey) ? t(r.messageKey, r.params as never) : t("errors.internal")}
              </p>
            )}
          </div>
        ),
      )}
    </section>
  );
}

/** **Complete ready orders** and **Finish batch**, kept in reach at the bottom of the screen. */
export function BatchFooter({ batch, actions }: { batch: PickBatch; actions: BatchActions }) {
  const t = useTranslations();
  const ready = readyMembers(batch);
  return (
    <footer
      data-toast-clearance
      className="fixed inset-x-0 bottom-0 z-10 flex justify-end gap-2 border-t border-base-300 bg-base-100 p-4"
    >
      <Button
        className="btn-outline btn-lg"
        isDisabled={actions.busy}
        onPress={() => actions.finish.mutate()}
      >
        {t("pickBatch.finish")}
      </Button>
      <Button
        className="btn-primary btn-lg"
        isDisabled={!actions.canComplete || ready.length === 0}
        onPress={() => actions.complete.mutate(ready)}
      >
        {t("pickBatch.completeReady", { count: ready.length })}
      </Button>
    </footer>
  );
}
