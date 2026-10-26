"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Box, WeightDisplay } from "@woolrus/contracts";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Form } from "react-aria-components";
import { Dialog } from "@/components/ui/dialog";
import { Button, NumberField, TextField } from "@/components/ui/fields";
import { useErrorMessage } from "@/lib/errors";
import { orpc } from "@/lib/orpc";
import { WeightInput } from "./weight-input";

const nan = (value: number | null | undefined) => value ?? Number.NaN;
const orNull = (value: number) => (Number.isNaN(value) ? null : value);

/** Adds a box, or edits `box`: its dimensions are locked while any package uses it. */
export function BoxDialog({
  box,
  weightDisplay,
  onClose,
}: {
  box: Box | null;
  weightDisplay: WeightDisplay;
  onClose: () => void;
}) {
  const t = useTranslations("boxes");
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const locked = box?.inUse ?? false;
  const [form, setForm] = useState({
    name: box?.name ?? "",
    lengthIn: nan(box?.lengthIn),
    widthIn: nan(box?.widthIn),
    heightIn: nan(box?.heightIn),
    outerLengthIn: nan(box?.outerLengthIn),
    outerWidthIn: nan(box?.outerWidthIn),
    outerHeightIn: nan(box?.outerHeightIn),
  });
  const [maxWeightOz, setMaxWeightOz] = useState(box?.maxWeightOz ?? null);
  const [tareWeightOz, setTareWeightOz] = useState(box?.tareWeightOz ?? null);
  // One key per dialog: a retried submit can't create two boxes.
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const save = useMutation({
    mutationFn: () => {
      const outer = {
        outerLengthIn: orNull(form.outerLengthIn),
        outerWidthIn: orNull(form.outerWidthIn),
        outerHeightIn: orNull(form.outerHeightIn),
      };
      const shared = { name: form.name, maxWeightOz, tareWeightOz, ...outer };
      if (box) {
        const dimensions = locked
          ? {}
          : { lengthIn: form.lengthIn, widthIn: form.widthIn, heightIn: form.heightIn };
        return orpc.boxes.update.call({
          id: box.id,
          ...shared,
          ...dimensions,
          ...(locked
            ? { outerLengthIn: undefined, outerWidthIn: undefined, outerHeightIn: undefined }
            : {}),
        });
      }
      return orpc.boxes.create.call({
        idempotencyKey,
        ...shared,
        lengthIn: form.lengthIn,
        widthIn: form.widthIn,
        heightIn: form.heightIn,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: orpc.boxes.key() });
      onClose();
    },
  });

  const dim = (key: keyof typeof form, label: string, required: boolean) => (
    <NumberField
      label={label}
      name={key}
      isRequired={required}
      isDisabled={locked}
      minValue={0.01}
      value={form[key] as number}
      onChange={(value) => setForm({ ...form, [key]: value })}
    />
  );

  return (
    <Dialog title={box ? t("edit") : t("add")} isOpen onOpenChange={(open) => !open && onClose()}>
      {(close) => (
        <Form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <TextField
            label={t("name")}
            name="name"
            isRequired
            value={form.name}
            onChange={(name) => setForm({ ...form, name })}
          />
          {locked && (
            <p role="note" className="text-sm" data-testid="box-locked">
              {t("lockedReason")}
            </p>
          )}
          <fieldset className="grid grid-cols-3 gap-x-2">
            <legend className="fieldset-legend">{t("inner")}</legend>
            {dim("lengthIn", t("length"), true)}
            {dim("widthIn", t("width"), true)}
            {dim("heightIn", t("height"), true)}
          </fieldset>
          <fieldset className="grid grid-cols-3 gap-x-2">
            <legend className="fieldset-legend">{t("outer")}</legend>
            {dim("outerLengthIn", t("length"), false)}
            {dim("outerWidthIn", t("width"), false)}
            {dim("outerHeightIn", t("height"), false)}
          </fieldset>
          <WeightInput
            label={t("tare")}
            valueOz={tareWeightOz}
            weightDisplay={weightDisplay}
            onChange={setTareWeightOz}
          />
          <WeightInput
            label={t("maxWeightColumn")}
            valueOz={maxWeightOz}
            weightDisplay={weightDisplay}
            onChange={setMaxWeightOz}
          />
          {save.error && (
            <p role="alert" className="text-error">
              {errorMessage(save.error)}
            </p>
          )}
          <div className="modal-action">
            <Button className="btn-ghost" onPress={close}>
              {t("cancel")}
            </Button>
            <Button type="submit" isPending={save.isPending}>
              {t("save")}
            </Button>
          </div>
        </Form>
      )}
    </Dialog>
  );
}
