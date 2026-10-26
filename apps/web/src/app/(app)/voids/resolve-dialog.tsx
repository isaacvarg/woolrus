"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { VOID_NOTES_MAX, type VoidResolution } from "@woolrus/contracts";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Form } from "react-aria-components";
import { Dialog } from "@/components/ui/dialog";
import { Button, Radio, RadioGroup, TextAreaField } from "@/components/ui/fields";
import { toast } from "@/components/ui/toast";
import { useErrorMessage, useFieldErrors } from "@/lib/errors";
import { client, orpc } from "@/lib/orpc";

const outcomes = ["HANDLED_MANUALLY", "REFUNDED", "LINE_EDITED"] as const;

/**
 * Records what an admin did in WooCommerce for the selected voids (FR-VOID-04): an outcome and a
 * required note. All or nothing; a refusal leaves the dialog open with the message.
 */
export function ResolveDialog({
  voidIds,
  onClose,
  onResolved,
}: {
  voidIds: string[];
  onClose: () => void;
  onResolved: () => void;
}) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const errorMessage = useErrorMessage();
  const fieldErrors = useFieldErrors();
  const [resolution, setResolution] = useState<VoidResolution>("HANDLED_MANUALLY");
  const [notes, setNotes] = useState("");
  const resolve = useMutation({
    mutationFn: () => client.voids.resolve({ voidIds, resolution, notes }),
    onSuccess: ({ resolved }) => {
      toast.success(t("voids.page.resolvedToast", { count: resolved }));
      onResolved();
      onClose();
    },
    onError: (error) => toast.error(errorMessage(error)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: orpc.voids.key() }),
  });

  return (
    <Dialog
      title={t("voids.page.resolveTitle", { count: voidIds.length })}
      isOpen
      onOpenChange={(open) => !open && onClose()}
    >
      {(close) => (
        <Form
          className="space-y-4"
          validationErrors={fieldErrors(resolve.error)}
          onSubmit={(event) => {
            event.preventDefault();
            resolve.mutate();
          }}
        >
          <RadioGroup
            label={t("voids.page.outcome")}
            name="resolution"
            value={resolution}
            onChange={(value) => setResolution(value as VoidResolution)}
          >
            {outcomes.map((id) => (
              <Radio key={id} value={id}>
                {t(`voids.page.outcomes.${id}`)}
              </Radio>
            ))}
          </RadioGroup>
          <TextAreaField
            label={t("voids.page.note")}
            description={t("voids.page.noteHint")}
            name="notes"
            isRequired
            maxLength={VOID_NOTES_MAX}
            // Whitespace alone is no note; the server trims and refuses it too.
            validate={(value) => (value.trim() ? null : t("errors.field.required"))}
            value={notes}
            onChange={setNotes}
          />
          <div className="modal-action">
            <Button className="btn-ghost" onPress={close}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" isPending={resolve.isPending}>
              {t("voids.page.confirm")}
            </Button>
          </div>
        </Form>
      )}
    </Dialog>
  );
}
