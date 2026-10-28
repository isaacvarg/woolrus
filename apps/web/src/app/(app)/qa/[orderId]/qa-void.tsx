"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { QaLabel, QaResult, QaView } from "@woolrus/contracts";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Form } from "react-aria-components";
import { Dialog } from "@/components/ui/dialog";
import { Button, TextField } from "@/components/ui/fields";
import { toast } from "@/components/ui/toast";
import { useErrorMessage } from "@/lib/errors";
import { client, orpc } from "@/lib/orpc";

// Void label (SPEC-qa "Settling and voiding"): confirm with a reason. A void that was requested
// but never answered (VOID_REQUESTED) can be sent again.

/** Whether a void can start or be repeated for the label. */
export const isVoidable = (label: Pick<QaLabel, "status">) =>
  label.status === "ACTIVE" || label.status === "VOID_REQUESTED";

export function VoidLabelButton({ orderId, label }: { orderId: string; label: QaLabel }) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const viewKey = orpc.qa.screen.queryKey({ input: { orderId } });
  const voidIt = useMutation({
    mutationFn: () => client.qa.voidLabel({ labelId: label.id, reason: reason.trim() }),
    onSuccess: (result: QaResult) => {
      queryClient.setQueryData<QaView>(viewKey, (v) => (v ? { ...v, ...result } : v));
      setOpen(false);
      setReason("");
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: viewKey }),
  });
  return (
    <>
      <Button
        onPress={() => setOpen(true)}
        data-testid="qa-void-label"
        className="btn btn-outline btn-error btn-sm"
      >
        {t(label.status === "VOID_REQUESTED" ? "qa.voidRetry" : "qa.voidLabel")}
      </Button>
      <Dialog title={t("qa.voidTitle")} isOpen={open} onOpenChange={setOpen}>
        {(close) => (
          <Form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              voidIt.mutate();
            }}
          >
            <p>{t("qa.voidBody")}</p>
            <TextField
              label={t("qa.voidReason")}
              name="reason"
              isRequired
              maxLength={500}
              validate={(value) => (value.trim() ? null : t("errors.field.required"))}
              value={reason}
              onChange={setReason}
            />
            <div className="modal-action">
              <Button className="btn-ghost" onPress={close}>
                {t("order.back")}
              </Button>
              <Button
                type="submit"
                className="btn-error"
                isPending={voidIt.isPending}
                data-testid="qa-void-confirm"
              >
                {t("qa.voidConfirm")}
              </Button>
            </div>
          </Form>
        )}
      </Dialog>
    </>
  );
}
