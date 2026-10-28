"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdminSettings } from "@woolrus/contracts";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Form } from "react-aria-components";
import { Button, NumberField } from "@/components/ui/fields";
import { toast } from "@/components/ui/toast";
import { useErrorMessage, useFieldErrors } from "@/lib/errors";
import { orpc } from "@/lib/orpc";

// The label cost check (SPEC-qa "Cost guard"): the two thresholds Complete QA asks about.
// An empty field turns that check off.

export function CostCheckSection() {
  const errorMessage = useErrorMessage();
  const settings = useQuery(orpc.settings.get.queryOptions());

  if (settings.isPending) return <span className="loading loading-spinner" />;
  if (settings.error) {
    return (
      <p role="alert" className="alert alert-error">
        {errorMessage(settings.error)}
      </p>
    );
  }
  return <CostCheckForm settings={settings.data} />;
}

const toNumber = (value: number | null) => value ?? Number.NaN;
const toNullable = (value: number) => (Number.isNaN(value) ? null : value);

function CostCheckForm({ settings }: { settings: AdminSettings }) {
  const t = useTranslations();
  const headingId = useId();
  const errorMessage = useErrorMessage();
  const fieldErrors = useFieldErrors();
  const queryClient = useQueryClient();
  const [ratio, setRatio] = useState(toNumber(settings.labelCostConfirmRatio));
  const [freeDollars, setFreeDollars] = useState(
    toNumber(
      settings.labelCostConfirmFreeCents === null ? null : settings.labelCostConfirmFreeCents / 100,
    ),
  );

  const save = useMutation(
    orpc.settings.update.mutationOptions({
      onSuccess: (updated) => {
        queryClient.setQueryData(orpc.settings.get.queryKey(), updated);
        toast.success(t("settings.shipping.costCheck.saved"));
      },
      onError: (error) => {
        if (Object.keys(fieldErrors(error)).length === 0) toast.error(errorMessage(error));
      },
    }),
  );

  return (
    <section aria-labelledby={headingId} className="card bg-base-100 shadow-sm">
      <Form
        className="card-body gap-4"
        validationErrors={save.error ? fieldErrors(save.error) : {}}
        onSubmit={(event) => {
          event.preventDefault();
          const freeCents = toNullable(freeDollars);
          save.mutate({
            labelCostConfirmRatio: toNullable(ratio),
            labelCostConfirmFreeCents: freeCents === null ? null : Math.round(freeCents * 100),
          });
        }}
      >
        <h2 id={headingId} className="card-title">
          {t("settings.shipping.costCheck.title")}
        </h2>
        <p className="text-sm text-base-content/70">{t("settings.shipping.costCheck.intro")}</p>
        <NumberField
          label={t("settings.shipping.costCheck.ratio")}
          description={t("settings.shipping.costCheck.ratioHint")}
          name="labelCostConfirmRatio"
          minValue={0.1}
          maxValue={9999.99}
          formatOptions={{ maximumFractionDigits: 2 }}
          value={ratio}
          onChange={setRatio}
        />
        <NumberField
          label={t("settings.shipping.costCheck.free")}
          description={t("settings.shipping.costCheck.freeHint")}
          name="labelCostConfirmFreeCents"
          minValue={0.01}
          formatOptions={{ style: "currency", currency: "USD" }}
          value={freeDollars}
          onChange={setFreeDollars}
        />
        <div>
          <Button type="submit" className="btn-primary" isDisabled={save.isPending}>
            {t("settings.shipping.costCheck.save")}
          </Button>
        </div>
      </Form>
    </section>
  );
}
