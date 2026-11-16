"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdminSettings, PackCheckMode, UpdateSettingsInput } from "@woolrus/contracts";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Form } from "react-aria-components";
import { Button, NumberField, SelectField } from "@/components/ui/fields";
import { toast } from "@/components/ui/toast";
import { useErrorMessage, useFieldErrors } from "@/lib/errors";
import { orpc } from "@/lib/orpc";

// Settings → Packing checks (SPEC-packing A1 "Settings"): one warehouse-wide mode per check, and
// the off-the-estimate threshold. Block arrives with approvals at the gate.

const checks = [
  "packCheckOverMax",
  "packCheckWeightOff",
  "packCheckWeightStale",
  "packCheckNoFit",
  "packCheckCustomDimensions",
] as const;
type CheckField = (typeof checks)[number];

/** The check each field sets, for its label and explanation. */
const checkOf = {
  packCheckOverMax: "OVER_MAX",
  packCheckWeightOff: "WEIGHT_OFF",
  packCheckWeightStale: "WEIGHT_STALE",
  packCheckNoFit: "NO_FIT",
  packCheckCustomDimensions: "CUSTOM_DIMENSIONS",
} as const satisfies Record<CheckField, string>;

type SettableMode = Extract<PackCheckMode, "OFF" | "WARN">;

export function PackingChecksSection() {
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
  return <PackingChecksForm settings={settings.data} />;
}

function PackingChecksForm({ settings }: { settings: AdminSettings }) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const fieldErrors = useFieldErrors();
  const queryClient = useQueryClient();
  const [modes, setModes] = useState<Record<CheckField, PackCheckMode>>(
    () => Object.fromEntries(checks.map((field) => [field, settings[field]])) as never,
  );
  const [percent, setPercent] = useState(settings.packCheckWeightOffPercent);

  const save = useMutation(
    orpc.settings.update.mutationOptions({
      onSuccess: (updated) => {
        queryClient.setQueryData(orpc.settings.get.queryKey(), updated);
        toast.success(t("settings.packingChecks.saved"));
      },
      onError: (error) => {
        if (Object.keys(fieldErrors(error)).length === 0) toast.error(errorMessage(error));
      },
    }),
  );

  return (
    <Form
      className="card bg-base-100 shadow-sm"
      validationErrors={save.error ? fieldErrors(save.error) : {}}
      onSubmit={(event) => {
        event.preventDefault();
        // Block isn't offered yet; a mode set to it elsewhere is left as it is.
        const patch = Object.fromEntries(
          checks.filter((field) => modes[field] !== "BLOCK").map((field) => [field, modes[field]]),
        );
        save.mutate({ ...patch, packCheckWeightOffPercent: percent } as UpdateSettingsInput);
      }}
    >
      <div className="card-body gap-4">
        <ul className="divide-y divide-base-300">
          {checks.map((field) => {
            const check = checkOf[field];
            const allowed: SettableMode[] =
              field === "packCheckOverMax" ? ["WARN"] : ["OFF", "WARN"];
            return (
              <li
                key={field}
                className="grid gap-x-6 py-3 sm:grid-cols-[14rem_1fr] sm:items-center"
              >
                <SelectField
                  label={t(`settings.packingChecks.${check}`)}
                  name={field}
                  options={allowed.map((id) => ({
                    id,
                    label: t(`settings.packingChecks.mode${id}`),
                  }))}
                  value={modes[field] === "BLOCK" ? null : modes[field]}
                  isDisabled={allowed.length === 1}
                  onChange={(key) => {
                    if (key === "OFF" || key === "WARN") {
                      setModes((current) => ({ ...current, [field]: key }));
                    }
                  }}
                />
                <p className="text-sm text-base-content/70">
                  {t(`settings.packingChecks.${check}Hint`)}
                </p>
              </li>
            );
          })}
        </ul>
        <NumberField
          label={t("settings.packingChecks.percent")}
          description={t("settings.packingChecks.percentHint")}
          name="packCheckWeightOffPercent"
          minValue={5}
          maxValue={100}
          step={1}
          value={percent}
          onChange={setPercent}
        />
        <div>
          <Button type="submit" className="btn-primary" isDisabled={save.isPending}>
            {t("settings.packingChecks.save")}
          </Button>
        </div>
      </div>
    </Form>
  );
}
