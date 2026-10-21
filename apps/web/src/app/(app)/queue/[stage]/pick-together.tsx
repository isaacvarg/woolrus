"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PICK_BATCH_MIN_ORDERS, type QueueRow } from "@woolrus/contracts";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/fields";
import { toast } from "@/components/ui/toast";
import { failuresOf, type OrderFailure, useErrorMessage } from "@/lib/errors";
import { client, orpc } from "@/lib/orpc";

// **Pick together** on the Pending queue (SPEC-picking "UI"): the ticked orders all become the
// picker's batch, or none do and the panel says which order failed and why.

type Refused = { number: string; failure: OrderFailure };

export function PickTogether({
  selected,
  onStarted,
}: {
  /** The ticked rows, in the order they were ticked. */
  selected: QueueRow[];
  onStarted: () => void;
}) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [refused, setRefused] = useState<Refused[] | null>(null);
  const settings = useQuery(orpc.settings.public.queryOptions());
  const max = settings.data?.pickBatchMaxOrders;

  const create = useMutation({
    mutationFn: (rows: QueueRow[]) =>
      client.pickBatches.create({
        idempotencyKey: crypto.randomUUID(),
        orders: rows.map((row) => ({ id: row.id, expectedVersion: row.version })),
      }),
    onMutate: () => setRefused(null),
    onSuccess: (batch) => {
      toast.success(t("queue.batchStarted", { number: batch.number, count: batch.members.length }));
      onStarted();
      router.push(`/pick/batch/${batch.id}`);
    },
    onError: (error, rows) => {
      const failures = failuresOf(error);
      if (!failures) {
        toast.error(errorMessage(error));
        return;
      }
      const numbers = new Map(rows.map((row) => [row.id, row.number]));
      setRefused(
        failures.map((failure) => ({ number: numbers.get(failure.orderId) ?? "", failure })),
      );
    },
    // Refused or not, the rows may have moved: show them as they are now.
    onSettled: () => queryClient.invalidateQueries({ queryKey: orpc.orders.key() }),
  });

  const count = selected.length;
  const tooMany = max !== undefined && count > max;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          isDisabled={count < PICK_BATCH_MIN_ORDERS || tooMany || max === undefined}
          isPending={create.isPending}
          onPress={() => create.mutate(selected)}
        >
          {t("queue.pickTogether", { count })}
        </Button>
        <p className={`text-sm ${tooMany ? "text-error" : "text-base-content/70"}`}>
          {max !== undefined &&
            (tooMany
              ? t("queue.pickTogetherTooMany", { max })
              : t("queue.pickTogetherHint", { max }))}
        </p>
      </div>
      {refused && (
        <div role="alert" className="alert alert-error flex-col items-start">
          <p className="font-semibold">{t("errors.picking.batchFailed")}</p>
          <ul className="list-disc ps-6">
            {refused.map(({ number, failure }) => (
              <li key={failure.orderId}>
                {t("queue.batchRefusedOrder", {
                  number,
                  reason: t.has(failure.messageKey)
                    ? t(failure.messageKey, failure.params as never)
                    : t("errors.internal"),
                })}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
