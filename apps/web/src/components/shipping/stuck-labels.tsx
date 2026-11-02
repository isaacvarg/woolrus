"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { Button, TextAreaField } from "@/components/ui/fields";
import { toast } from "@/components/ui/toast";
import { useErrorMessage } from "@/lib/errors";
import { client, orpc } from "@/lib/orpc";

/**
 * Labels of a Ready order whose void was rejected or never answered: Retry void for whoever may
 * repack, Write off (with a reason) for admins who checked with the carrier (SPEC-shipping
 * "Repack (write-off)"). Renders nothing when there are none, or for someone who can't repack.
 */
export function StuckLabels({ orderId }: { orderId: string }) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const stuck = useQuery({
    ...orpc.shipping.stuckLabels.queryOptions({ input: { orderId } }),
    retry: false,
  });
  const [writeOffId, setWriteOffId] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: orpc.shipping.key() });
    queryClient.invalidateQueries({ queryKey: orpc.orders.key() });
  };
  const retry = useMutation({
    mutationFn: (labelId: string) => client.shipping.retryVoid({ labelId }),
    onSuccess: ({ status }) =>
      status === "VOIDED"
        ? toast.success(t("stuckLabels.retried"))
        : toast.error(t("stuckLabels.stillStuck")),
    onError: (error) => toast.error(errorMessage(error)),
    onSettled: refresh,
  });
  const writeOff = useMutation({
    mutationFn: (labelId: string) => client.shipping.writeOffLabel({ labelId, reason }),
    onSuccess: () => {
      setWriteOffId(null);
      setReason("");
      toast.success(t("stuckLabels.writtenOff"));
    },
    onError: (error) => toast.error(errorMessage(error)),
    onSettled: refresh,
  });

  if (!stuck.data?.labels.length) return null;

  return (
    <section
      className="space-y-3 rounded-box border border-warning bg-base-100 p-4 shadow-sm"
      data-testid="stuck-labels"
    >
      <h2 className="text-xl font-semibold">{t("stuckLabels.title")}</h2>
      <p>{t("stuckLabels.intro")}</p>
      <ul className="divide-y divide-base-300">
        {stuck.data.labels.map((label) => (
          <li key={label.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
            <span>
              {t("stuckLabels.package", { number: label.packageNumber })}
              <span className="badge badge-sm badge-warning ms-2">
                {label.status === "VOID_REJECTED"
                  ? t("stuckLabels.rejected")
                  : t("stuckLabels.requested")}
              </span>
              {label.error && t.has(label.error) && (
                <span className="ms-2 opacity-70">{t(label.error as never)}</span>
              )}
            </span>
            <span className="flex gap-2">
              <Button
                className="btn-outline"
                isPending={retry.isPending && retry.variables === label.id}
                onPress={() => retry.mutate(label.id)}
              >
                {t("stuckLabels.retry")}
              </Button>
              {stuck.data.canWriteOff && (
                <Button className="btn-outline btn-error" onPress={() => setWriteOffId(label.id)}>
                  {t("stuckLabels.writeOff")}
                </Button>
              )}
            </span>
          </li>
        ))}
      </ul>
      <Dialog
        title={t("stuckLabels.writeOffTitle")}
        isOpen={writeOffId !== null}
        onOpenChange={(open) => !open && setWriteOffId(null)}
      >
        {(close) => (
          <>
            <p>{t("stuckLabels.writeOffBody")}</p>
            <TextAreaField
              label={t("stuckLabels.reason")}
              value={reason}
              onChange={setReason}
              isRequired
            />
            <div className="flex justify-end gap-2">
              <Button onPress={close}>{t("stuckLabels.cancel")}</Button>
              <Button
                isDisabled={!reason.trim()}
                isPending={writeOff.isPending}
                onPress={() => writeOffId && writeOff.mutate(writeOffId)}
              >
                {t("stuckLabels.confirm")}
              </Button>
            </div>
          </>
        )}
      </Dialog>
    </section>
  );
}
