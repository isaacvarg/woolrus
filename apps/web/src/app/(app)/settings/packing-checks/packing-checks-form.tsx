"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AdminSettings,
  PackCheck,
  PackCheckMode,
  QaBoxConfirm,
  UpdateSettingsInput,
} from "@woolrus/contracts";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Form } from "react-aria-components";
import { Button, NumberField, SelectField } from "@/components/ui/fields";
import { toast } from "@/components/ui/toast";
import { useErrorMessage, useFieldErrors } from "@/lib/errors";
import { orpc } from "@/lib/orpc";

// Settings → Packing checks (SPEC-packing A1 "Settings"): one warehouse-wide mode per check, and
// the off-the-estimate threshold, and which packages QA confirms the box of. Block stops Complete
// packing until a QA or Admin user approves.

const checks = [
  "packCheckOverMax",
  "packCheckUnderMin",
  "packCheckWeightOff",
  "packCheckWeightStale",
  "packCheckNoFit",
  "packCheckBoxNotScanned",
  "packCheckCustomDimensions",
] as const;
type CheckField = (typeof checks)[number];

/** The check each field sets, for its label and explanation. */
const checkOf = {
  packCheckOverMax: "OVER_MAX",
  packCheckUnderMin: "UNDER_MIN",
  packCheckWeightOff: "WEIGHT_OFF",
  packCheckWeightStale: "WEIGHT_STALE",
  packCheckNoFit: "NO_FIT",
  packCheckBoxNotScanned: "BOX_NOT_SCANNED",
  packCheckCustomDimensions: "CUSTOM_DIMENSIONS",
} as const satisfies Record<CheckField, string>;

const boxConfirmModes: readonly QaBoxConfirm[] = ["OFF", "WHEN_TRIPPED", "ALWAYS"];

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
  const [boxConfirm, setBoxConfirm] = useState<QaBoxConfirm>(settings.qaBoxConfirm);
  // The 30-day counts beside each mode; the form works without them while they load.
  const stats = useQuery(orpc.packChecks.stats.queryOptions());
  const statOf = (check: PackCheck) => stats.data?.find((s) => s.check === check);

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
        save.mutate({
          ...modes,
          packCheckWeightOffPercent: percent,
          qaBoxConfirm: boxConfirm,
        } as UpdateSettingsInput);
      }}
    >
      <div className="card-body gap-4">
        <ul className="divide-y divide-base-300">
          {checks.map((field) => {
            const check = checkOf[field];
            // Over max is a physical limit: warn or block, never off (decision 11).
            const allowed: PackCheckMode[] =
              field === "packCheckOverMax" ? ["WARN", "BLOCK"] : ["OFF", "WARN", "BLOCK"];
            return (
              <li
                key={field}
                className="grid gap-x-6 py-3 sm:grid-cols-[14rem_1fr] sm:items-center"
              >
                <SelectField
                  label={t(`settings.packingChecks.${check}`)}
                  name={field}
                  // The hint and 30-day counts sit beside it on wide screens; they describe it.
                  aria-describedby={`${field}-about`}
                  options={allowed.map((id) => ({
                    id,
                    label: t(`settings.packingChecks.mode${id}`),
                  }))}
                  value={modes[field]}
                  onChange={(key) => {
                    const mode = allowed.find((id) => id === key);
                    if (mode) setModes((current) => ({ ...current, [field]: mode }));
                  }}
                />
                <div className="text-sm" id={`${field}-about`}>
                  <p className="text-base-content/70">{t(`settings.packingChecks.${check}Hint`)}</p>
                  {statOf(check) ? (
                    <p className="mt-1 font-medium" data-stat={check}>
                      {t("settings.packingChecks.stats", statOf(check))}
                    </p>
                  ) : null}
                </div>
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
          <SelectField
            label={t("settings.packingChecks.qaBoxConfirm")}
            name="qaBoxConfirm"
            aria-describedby="qaBoxConfirm-about"
            options={boxConfirmModes.map((id) => ({
              id,
              label: t(`settings.packingChecks.qaBoxConfirm${id}`),
            }))}
            value={boxConfirm}
            onChange={(key) => {
              const mode = boxConfirmModes.find((m) => m === key);
              if (mode) setBoxConfirm(mode);
            }}
          />
          <p className="text-sm text-base-content/70" id="qaBoxConfirm-about">
            {t("settings.packingChecks.qaBoxConfirmHint")}
          </p>
        </div>
        <div>
          <Button type="submit" className="btn-primary" isDisabled={save.isPending}>
            {t("settings.packingChecks.save")}
          </Button>
        </div>
      </div>
    </Form>
  );
}
