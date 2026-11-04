"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type AdminSettings, RATE_LAB_MAX_COMBINATIONS_CEILING } from "@woolrus/contracts";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Form } from "react-aria-components";
import { Button, NumberField } from "@/components/ui/fields";
import { toast } from "@/components/ui/toast";
import { useErrorMessage, useFieldErrors } from "@/lib/errors";
import { orpc } from "@/lib/orpc";

// Rate Lab's combination cap (SPEC-rate-lab "Runs"): the most address × parcel combinations one
// run may quote. The New run dialog checks against it.

export function RateLabCapSection() {
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
  return <RateLabCapForm settings={settings.data} />;
}

function RateLabCapForm({ settings }: { settings: AdminSettings }) {
  const t = useTranslations();
  const headingId = useId();
  const errorMessage = useErrorMessage();
  const fieldErrors = useFieldErrors();
  const queryClient = useQueryClient();
  const [cap, setCap] = useState(settings.rateLabMaxCombinations);

  const save = useMutation(
    orpc.settings.update.mutationOptions({
      onSuccess: async (updated) => {
        queryClient.setQueryData(orpc.settings.get.queryKey(), updated);
        // The New run dialog's count says whether a selection is over the cap.
        await queryClient.invalidateQueries({ queryKey: orpc.rateLab.previewRun.key() });
        toast.success(t("settings.shipping.rateLab.saved"));
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
          save.mutate({ rateLabMaxCombinations: cap });
        }}
      >
        <h2 id={headingId} className="card-title">
          {t("settings.shipping.rateLab.title")}
        </h2>
        <p className="text-sm text-base-content/70">{t("settings.shipping.rateLab.intro")}</p>
        <NumberField
          label={t("settings.shipping.rateLab.cap")}
          description={t("settings.shipping.rateLab.capHint")}
          name="rateLabMaxCombinations"
          isRequired
          minValue={1}
          maxValue={RATE_LAB_MAX_COMBINATIONS_CEILING}
          step={1}
          value={cap}
          onChange={setCap}
        />
        <div>
          <Button type="submit" className="btn-primary" isDisabled={save.isPending}>
            {t("settings.shipping.rateLab.save")}
          </Button>
        </div>
      </Form>
    </section>
  );
}
