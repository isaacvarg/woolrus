"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatWeight } from "@woolrus/core/format";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { Form } from "react-aria-components";
import { Button, NumberField, TextField } from "@/components/ui/fields";
import { useErrorMessage, useFieldErrors } from "@/lib/errors";
import { orpc } from "@/lib/orpc";

const emptyForm = {
  name: "",
  lengthIn: Number.NaN,
  widthIn: Number.NaN,
  heightIn: Number.NaN,
  maxWeightLb: Number.NaN,
};

export function BoxesManager() {
  const t = useTranslations();
  const locale = useLocale();
  const errorMessage = useErrorMessage();
  const fieldErrors = useFieldErrors();
  const queryClient = useQueryClient();
  const boxes = useQuery(orpc.boxes.list.queryOptions({ input: { includeArchived: false } }));
  const settings = useQuery(orpc.settings.public.queryOptions());
  // Until settings load, use the schema default so the table isn't held back.
  const weightDisplay = settings.data?.weightDisplay ?? "LB_OZ";
  const [form, setForm] = useState(emptyForm);
  // One key per form submission: retries of the same submission can't create two boxes.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  const create = useMutation(
    orpc.boxes.create.mutationOptions({
      onSuccess: () => {
        setForm(emptyForm);
        setIdempotencyKey(crypto.randomUUID());
        return queryClient.invalidateQueries({ queryKey: orpc.boxes.key() });
      },
    }),
  );

  return (
    <div className="space-y-6">
      <div className="overflow-x-auto rounded-box bg-base-100 shadow-sm">
        <table className="table">
          <thead>
            <tr>
              <th>{t("boxes.name")}</th>
              <th>{t("boxes.dimensions")}</th>
              <th>{t("boxes.maxWeightColumn")}</th>
            </tr>
          </thead>
          <tbody>
            {boxes.isPending && (
              <tr>
                <td colSpan={3}>{t("common.loading")}</td>
              </tr>
            )}
            {boxes.error && (
              <tr>
                <td colSpan={3} className="text-error">
                  {errorMessage(boxes.error)}
                </td>
              </tr>
            )}
            {boxes.data?.length === 0 && (
              <tr>
                <td colSpan={3}>{t("common.empty")}</td>
              </tr>
            )}
            {boxes.data?.map((box) => (
              <tr key={box.id}>
                <td>{box.name}</td>
                <td>
                  {box.lengthIn} × {box.widthIn} × {box.heightIn}
                </td>
                <td>
                  {box.maxWeightOz === null
                    ? "—"
                    : formatWeight(box.maxWeightOz, weightDisplay, locale)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Form
        className="card bg-base-100 shadow-sm"
        validationErrors={fieldErrors(create.error)}
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate({
            idempotencyKey,
            name: form.name,
            lengthIn: form.lengthIn,
            widthIn: form.widthIn,
            heightIn: form.heightIn,
            maxWeightOz: Number.isNaN(form.maxWeightLb)
              ? null
              : Math.round(form.maxWeightLb * 16 * 100) / 100,
            tareWeightOz: null,
          });
        }}
      >
        <div className="card-body">
          <h2 className="card-title">{t("boxes.add")}</h2>
          <div className="grid gap-x-4 sm:grid-cols-2 lg:grid-cols-5">
            <TextField
              label={t("boxes.name")}
              name="name"
              isRequired
              value={form.name}
              onChange={(name) => setForm({ ...form, name })}
            />
            <NumberField
              label={t("boxes.length")}
              name="lengthIn"
              isRequired
              minValue={0.01}
              value={form.lengthIn}
              onChange={(lengthIn) => setForm({ ...form, lengthIn })}
            />
            <NumberField
              label={t("boxes.width")}
              name="widthIn"
              isRequired
              minValue={0.01}
              value={form.widthIn}
              onChange={(widthIn) => setForm({ ...form, widthIn })}
            />
            <NumberField
              label={t("boxes.height")}
              name="heightIn"
              isRequired
              minValue={0.01}
              value={form.heightIn}
              onChange={(heightIn) => setForm({ ...form, heightIn })}
            />
            <NumberField
              label={t("boxes.maxWeight")}
              name="maxWeightOz"
              minValue={0.01}
              value={form.maxWeightLb}
              onChange={(maxWeightLb) => setForm({ ...form, maxWeightLb })}
            />
          </div>
          {create.error && (
            <p role="alert" className="text-error">
              {errorMessage(create.error)}
            </p>
          )}
          <div className="card-actions justify-end">
            <Button type="submit" isPending={create.isPending}>
              {t("common.save")}
            </Button>
          </div>
        </div>
      </Form>
    </div>
  );
}
