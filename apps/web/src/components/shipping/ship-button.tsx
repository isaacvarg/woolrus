"use client";

import { ORPCError } from "@orpc/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ShipOrdersResult } from "@woolrus/contracts";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/fields";
import { toast } from "@/components/ui/toast";
import { useErrorMessage } from "@/lib/errors";
import { client, orpc } from "@/lib/orpc";

/** The most orders one call ships (`ShipOrdersInput`); past it the button is off rather than shipping a prefix. */
const MAX_SHIP_ORDERS = 50;

const isUnprinted = (error: unknown) =>
  error instanceof ORPCError &&
  (error.data as { messageKey?: unknown } | undefined)?.messageKey ===
    "errors.shipping.unprintedLabels";

/**
 * Ships the ticked Ready orders (SPEC-shipping "Ship"). If the server reports never-printed labels
 * it asks first and resends with `confirmUnprinted`; results are reported per order.
 */
export function ShipButton({
  orderIds,
  onShipped,
}: {
  orderIds: string[];
  onShipped?: () => void;
}) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const [unprinted, setUnprinted] = useState<string | null>(null);
  // One key per click-through, so a resend after confirming is a new call but a retry is a replay.
  const [attempt, setAttempt] = useState(() => crypto.randomUUID());

  const ship = useMutation({
    mutationFn: (confirmUnprinted: boolean) =>
      client.shipping.shipOrders({
        orderIds,
        confirmUnprinted,
        idempotencyKey: attempt,
      }),
    onSuccess: ({ results }: ShipOrdersResult) => {
      setUnprinted(null);
      setAttempt(crypto.randomUUID());
      const failed = results.filter((r) => !r.ok);
      const shipped = results.length - failed.length;
      if (shipped > 0) toast.success(t("ship.shipped", { count: shipped }));
      for (const r of failed) {
        if (r.ok) continue;
        toast.error(
          t("ship.failed", {
            number: r.orderNumber,
            reason: t.has(r.messageKey) ? t(r.messageKey, r.params as never) : t("errors.internal"),
          }),
        );
      }
      onShipped?.();
    },
    onError: (error) => {
      if (isUnprinted(error)) {
        const params = (error as ORPCError<string, { params?: { orderNumbers?: string } }>).data
          ?.params;
        setUnprinted(params?.orderNumbers ?? "");
        // The server wrote nothing, so the same key can carry the confirmed resend.
        return;
      }
      setAttempt(crypto.randomUUID());
      toast.error(errorMessage(error));
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: orpc.orders.key() });
      queryClient.invalidateQueries({ queryKey: orpc.shipping.key() });
    },
  });

  return (
    <>
      <Button
        isDisabled={orderIds.length === 0 || orderIds.length > MAX_SHIP_ORDERS}
        isPending={ship.isPending}
        onPress={() => ship.mutate(false)}
      >
        {orderIds.length > 0 ? t("ship.shipSelected", { count: orderIds.length }) : t("ship.ship")}
      </Button>
      <Dialog
        title={t("ship.unprintedTitle")}
        isOpen={unprinted !== null}
        onOpenChange={(open) => !open && setUnprinted(null)}
      >
        {(close) => (
          <>
            <p>{t("ship.unprintedBody", { orders: unprinted ?? "" })}</p>
            <div className="flex justify-end gap-2">
              <Button onPress={close}>{t("ship.cancel")}</Button>
              <Button isPending={ship.isPending} onPress={() => ship.mutate(true)}>
                {t("ship.shipAnyway")}
              </Button>
            </div>
          </>
        )}
      </Dialog>
    </>
  );
}
