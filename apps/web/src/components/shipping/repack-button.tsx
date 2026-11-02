"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { RepackResult } from "@woolrus/contracts";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { Button, TextAreaField } from "@/components/ui/fields";
import { toast } from "@/components/ui/toast";
import { useErrorMessage } from "@/lib/errors";
import { client, orpc } from "@/lib/orpc";

/**
 * Sends the ticked Ready orders back to Packing (SPEC-shipping "Repack"): asks for a reason and warns
 * that their labels are voided. Each order answers on its own; one whose carrier refused the void
 * stays in Ready and the toast names the package (retry or write off on the order page).
 */
export function RepackButton({
  orderNumbers,
  onRepacked,
}: {
  /** The ticked orders by id, with the number to name them by. */
  orderNumbers: Map<string, string>;
  onRepacked?: () => void;
}) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [attempt, setAttempt] = useState(() => crypto.randomUUID());

  const repack = useMutation({
    mutationFn: () =>
      client.shipping.repack({
        orderIds: [...orderNumbers.keys()].slice(0, 10),
        reason: reason.trim(),
        idempotencyKey: attempt,
      }),
    onSuccess: ({ orders }: RepackResult) => {
      setOpen(false);
      setReason("");
      setAttempt(crypto.randomUUID());
      const done = orders.filter((o) => o.repacked).length;
      if (done > 0) toast.success(t("repack.repacked", { count: done }));
      for (const o of orders) {
        if (o.repacked) continue;
        const number = orderNumbers.get(o.orderId) ?? "";
        const why = o.blocked.map((b) =>
          t("repack.blocked", {
            package: b.packageNumber,
            reason: b.error && t.has(b.error) ? t(b.error as never) : t("errors.internal"),
          }),
        );
        toast.error(
          t("repack.failed", {
            number,
            reason: why.length
              ? why.join(" ")
              : o.error && t.has(o.error)
                ? t(o.error as never)
                : t("errors.internal"),
          }),
        );
      }
      onRepacked?.();
    },
    onError: (error) => {
      setAttempt(crypto.randomUUID());
      toast.error(errorMessage(error));
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: orpc.orders.key() });
      queryClient.invalidateQueries({ queryKey: orpc.shipping.key() });
    },
  });

  const count = orderNumbers.size;
  return (
    <>
      <Button isDisabled={count === 0 || count > 10} onPress={() => setOpen(true)}>
        {count > 0 ? t("repack.repackSelected", { count }) : t("repack.repack")}
      </Button>
      <Dialog title={t("repack.title")} isOpen={open} onOpenChange={setOpen}>
        {(close) => (
          <>
            <p role="alert">{t("repack.warning", { count })}</p>
            <TextAreaField
              label={t("repack.reason")}
              value={reason}
              onChange={setReason}
              isRequired
            />
            <div className="flex justify-end gap-2">
              <Button onPress={close}>{t("repack.cancel")}</Button>
              <Button
                isDisabled={!reason.trim()}
                isPending={repack.isPending}
                onPress={() => repack.mutate()}
              >
                {t("repack.confirm")}
              </Button>
            </div>
          </>
        )}
      </Dialog>
    </>
  );
}
