"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { LotDto, QaResult, QaRow, QaView } from "@woolrus/contracts";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Form } from "react-aria-components";
import { LotStatus, useLotText } from "@/components/lots/lot-status";
import { Dialog } from "@/components/ui/dialog";
import { Button, TextField } from "@/components/ui/fields";
import { toast } from "@/components/ui/toast";
import { useErrorMessage } from "@/lib/errors";
import { client, orpc } from "@/lib/orpc";
import { randomUUID } from "@/lib/uuid";

// A QA row's lots (SPEC-lumexia "Reads and UI"): each with its Lumexia status. `NOT_FOUND` and
// `UNVERIFIED` only warn; a `WRONG_ITEM` lot blocks the label until QA replaces or removes it.

/** The QA writes on lots share the screen's lane, so they land in the order they were made. */
function useLotWrite<I>(orderId: string, mutationFn: (input: I) => Promise<QaResult>) {
  const queryClient = useQueryClient();
  const viewKey = orpc.qa.screen.queryKey({ input: { orderId } });
  return useMutation({
    mutationKey: ["qaWrite", orderId],
    scope: { id: `qa:${orderId}` },
    mutationFn,
    onSuccess: async (result: QaResult) => {
      await queryClient.cancelQueries({ queryKey: viewKey });
      queryClient.setQueryData<QaView>(viewKey, (v) => (v ? { ...v, ...result } : v));
    },
  });
}

export function RowLots({
  row,
  orderId,
  disabled,
}: {
  row: QaRow;
  orderId: string;
  disabled: boolean;
}) {
  const t = useTranslations();
  const lotText = useLotText();
  const errorMessage = useErrorMessage();
  const [replacing, setReplacing] = useState<LotDto | null>(null);
  const remove = useLotWrite(orderId, (lot: LotDto) => client.qa.removeLot({ lotId: lot.id }));

  if (row.lots.length === 0) {
    return row.needsLot ? (
      <p className="ps-3 pt-1 text-sm" data-testid="qa-lot-none">
        {t("qa.lotNone")}
      </p>
    ) : null;
  }
  return (
    <>
      <ul className="grid gap-1 ps-3 pt-1 text-sm" aria-label={t("qa.lots", { name: row.name })}>
        {row.lots.map((lot) => {
          const blocking = lot.status === "WRONG_ITEM";
          return (
            <li
              key={lot.id}
              data-testid="qa-lot"
              data-status={lot.status}
              className={`flex flex-wrap items-center gap-x-3 gap-y-1 ${
                blocking ? "rounded-box border border-error p-2" : ""
              }`}
            >
              <span className="font-semibold">
                {t("qa.lotUnits", { count: lot.quantity, lot: lotText(lot) })}
              </span>
              <LotStatus status={lot.status} warnUnverified />
              {blocking && (
                <>
                  <span className="badge badge-error" data-testid="qa-lot-blocking">
                    {t("qa.lotBlocks")}
                  </span>
                  <span className="ms-auto flex gap-2">
                    <Button
                      className="btn-sm btn-primary"
                      isDisabled={disabled}
                      onPress={() => setReplacing(lot)}
                    >
                      {t("qa.lotReplace")}
                    </Button>
                    <Button
                      className="btn-sm btn-outline btn-error"
                      isDisabled={disabled}
                      isPending={remove.isPending && remove.variables?.id === lot.id}
                      onPress={() =>
                        remove.mutate(lot, { onError: (error) => toast.error(errorMessage(error)) })
                      }
                      aria-label={t("qa.lotRemoveNamed", { lot: lotText(lot) })}
                    >
                      {t("qa.lotRemove")}
                    </Button>
                  </span>
                </>
              )}
            </li>
          );
        })}
      </ul>
      {replacing && (
        <ReplaceLotDialog
          row={row}
          lot={replacing}
          orderId={orderId}
          onClose={() => setReplacing(null)}
        />
      )}
    </>
  );
}

/**
 * **Replace lot**: the scanner types the right lot's code into the field and presses Enter. A lot
 * for yet another item is refused here, like at Packing, and the dialog stays open to try again.
 */
function ReplaceLotDialog({
  row,
  lot,
  orderId,
  onClose,
}: {
  row: QaRow;
  lot: LotDto;
  orderId: string;
  onClose: () => void;
}) {
  const t = useTranslations();
  const lotText = useLotText();
  const errorMessage = useErrorMessage();
  const [code, setCode] = useState("");
  const replace = useLotWrite(orderId, (input: { code: string; scanId: string }) =>
    client.qa.replaceLot({ lotId: lot.id, ...input }),
  );
  return (
    <Dialog
      title={t("qa.lotReplaceTitle", { lot: lotText(lot) })}
      isOpen
      onOpenChange={(open) => !open && onClose()}
    >
      {(close) => (
        <Form
          className="space-y-4"
          data-testid="qa-replace-lot"
          onSubmit={(event) => {
            event.preventDefault();
            if (!code.trim()) return;
            // One id per scan, so a retried request doesn't replace twice.
            replace.mutate(
              { code, scanId: randomUUID() },
              { onSuccess: () => close(), onError: () => setCode("") },
            );
          }}
        >
          <p>{t("qa.lotReplaceIntro", { name: row.name, count: lot.quantity })}</p>
          <TextField
            label={t("qa.lotReplaceField")}
            description={t("qa.lotReplaceHint")}
            value={code}
            onChange={setCode}
            autoFocus
            isRequired
          />
          {replace.error && (
            <p role="alert" className="alert alert-error" data-testid="qa-replace-lot-error">
              {errorMessage(replace.error)}
            </p>
          )}
          <div className="modal-action">
            <Button className="btn-ghost" onPress={close}>
              {t("order.back")}
            </Button>
            <Button type="submit" className="btn-primary" isPending={replace.isPending}>
              {t("qa.lotReplaceSave")}
            </Button>
          </div>
        </Form>
      )}
    </Dialog>
  );
}
