"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdminSettings, UpdateSettingsInput, WeightDisplay } from "@woolrus/contracts";
import { formatWeight } from "@woolrus/core/format";
import { useLocale, useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Form } from "react-aria-components";
import {
  Button,
  Checkbox,
  NumberField,
  Radio,
  RadioGroup,
  TextField,
} from "@/components/ui/fields";
import { useErrorMessage, useFieldErrors } from "@/lib/errors";
import { orpc } from "@/lib/orpc";

const addressFields = [
  "name",
  "company",
  "phone",
  "email",
  "address1",
  "address2",
  "city",
  "state",
  "postalCode",
] as const;
type AddressField = (typeof addressFields)[number];
const optionalAddressFields: readonly AddressField[] = ["company", "email", "address2"];

const stages = ["PENDING", "PICKING", "PACKING", "QA", "READY"] as const;
type Stage = (typeof stages)[number];

/** What the inputs hold: text as strings ("" = empty), numbers as NaN when empty. */
type FormState = {
  shipFrom: Record<AddressField, string>;
  syncIntervalMinutes: number;
  stationIdleLockMinutes: number;
  claimExpiryMinutes: number;
  sla: Record<Stage, number>;
  weightDisplay: WeightDisplay;
  piiRetentionDays: number;
  qaMustDifferFromPacker: boolean;
};

function toForm(settings: AdminSettings): FormState {
  const address = settings.shipFromAddress;
  return {
    shipFrom: Object.fromEntries(addressFields.map((f) => [f, address?.[f] ?? ""])) as Record<
      AddressField,
      string
    >,
    syncIntervalMinutes: settings.syncIntervalMinutes,
    stationIdleLockMinutes: settings.stationIdleLockMinutes,
    claimExpiryMinutes: settings.claimExpiryMinutes,
    sla: Object.fromEntries(
      stages.map((s) => [s, settings.stageSlaMinutes[s] ?? Number.NaN]),
    ) as Record<Stage, number>,
    weightDisplay: settings.weightDisplay,
    piiRetentionDays: settings.piiRetentionDays ?? Number.NaN,
    qaMustDifferFromPacker: settings.qaMustDifferFromPacker,
  };
}

function toInput(form: FormState): UpdateSettingsInput {
  const address = Object.fromEntries(
    addressFields
      .filter((f) => form.shipFrom[f] !== "" || !optionalAddressFields.includes(f))
      .map((f) => [f, form.shipFrom[f]]),
  );
  const addressEntered = addressFields.some((f) => form.shipFrom[f] !== "");
  return {
    // The API can't unset the address, so an empty address block is simply not sent.
    shipFromAddress: addressEntered
      ? ({ ...address, country: "US" } as UpdateSettingsInput["shipFromAddress"])
      : undefined,
    syncIntervalMinutes: form.syncIntervalMinutes,
    stationIdleLockMinutes: form.stationIdleLockMinutes,
    claimExpiryMinutes: form.claimExpiryMinutes,
    stageSlaMinutes: Object.fromEntries(
      stages.filter((s) => !Number.isNaN(form.sla[s])).map((s) => [s, form.sla[s]]),
    ),
    weightDisplay: form.weightDisplay,
    piiRetentionDays: Number.isNaN(form.piiRetentionDays) ? null : form.piiRetentionDays,
    qaMustDifferFromPacker: form.qaMustDifferFromPacker,
  };
}

/**
 * Only the fields that differ from what was loaded, so a save doesn't overwrite another admin's
 * change to a field this form didn't touch.
 */
function changedFields(form: FormState, loaded: FormState): UpdateSettingsInput {
  const next = toInput(form);
  const before = toInput(loaded);
  return Object.fromEntries(
    (Object.keys(next) as (keyof UpdateSettingsInput)[])
      .filter((key) => JSON.stringify(next[key]) !== JSON.stringify(before[key]))
      .map((key) => [key, next[key]]),
  );
}

export function GeneralSection() {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const settings = useQuery(orpc.settings.get.queryOptions());

  if (settings.isPending) return <p>{t("common.loading")}</p>;
  if (settings.error) {
    return (
      <p role="alert" className="text-error">
        {errorMessage(settings.error)}
      </p>
    );
  }
  return <GeneralForm settings={settings.data} />;
}

function GeneralForm({ settings }: { settings: AdminSettings }) {
  const t = useTranslations();
  const locale = useLocale();
  const errorMessage = useErrorMessage();
  const fieldErrors = useFieldErrors();
  const queryClient = useQueryClient();
  const headingId = useId();
  const [loaded, setLoaded] = useState(() => toForm(settings));
  const [form, setForm] = useState(loaded);
  // Held in state, not derived from save.error on each render: React Aria re-applies a new
  // validationErrors object, so an edited field would keep its old message and block the submit.
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});

  const save = useMutation(
    orpc.settings.update.mutationOptions({
      onMutate: () => setServerErrors({}),
      onError: (error) => setServerErrors(fieldErrors(error)),
      onSuccess: (updated) => {
        const next = toForm(updated);
        setLoaded(next);
        setForm(next);
        queryClient.setQueryData(orpc.settings.get.queryKey(), updated);
        return queryClient.invalidateQueries({ queryKey: orpc.settings.public.key() });
      },
    }),
  );

  /** `name` is the edited field's: its server error goes, the other fields' stay. */
  const edit = (name: string, patch: Partial<FormState>) => {
    if (save.isSuccess) save.reset();
    if (name in serverErrors) {
      setServerErrors(({ [name]: _, ...rest }) => rest);
    }
    setForm((current) => ({ ...current, ...patch }));
  };
  const editAddress = (field: AddressField, value: string) =>
    edit(`shipFromAddress.${field}`, { shipFrom: { ...form.shipFrom, [field]: value } });
  const addressField = (field: AddressField, type?: "tel" | "email") => (
    <TextField
      label={t(`settings.shipFrom.${field}`)}
      name={`shipFromAddress.${field}`}
      type={type}
      value={form.shipFrom[field]}
      onChange={(value) => editAddress(field, value)}
    />
  );

  return (
    <Form
      aria-labelledby={headingId}
      className="card bg-base-100 shadow-sm"
      validationErrors={serverErrors}
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate(changedFields(form, loaded));
      }}
    >
      <div className="card-body">
        <h2 id={headingId} className="card-title">
          {t("settings.general")}
        </h2>

        <fieldset className="grid gap-x-4 sm:grid-cols-2">
          <legend className="mb-1 font-semibold">{t("settings.shipFrom.title")}</legend>
          {addressField("name")}
          {addressField("company")}
          {addressField("phone", "tel")}
          {addressField("email", "email")}
          {addressField("address1")}
          {addressField("address2")}
          {addressField("city")}
          <div className="grid grid-cols-2 gap-x-4">
            {addressField("state")}
            {addressField("postalCode")}
          </div>
        </fieldset>

        <div className="grid gap-x-4 sm:grid-cols-2">
          <NumberField
            label={t("settings.syncInterval")}
            name="syncIntervalMinutes"
            isRequired
            minValue={1}
            maxValue={60}
            formatOptions={{ maximumFractionDigits: 0 }}
            value={form.syncIntervalMinutes}
            onChange={(syncIntervalMinutes) => edit("syncIntervalMinutes", { syncIntervalMinutes })}
          />
          <NumberField
            label={t("settings.stationIdleLock")}
            name="stationIdleLockMinutes"
            isRequired
            minValue={1}
            maxValue={120}
            formatOptions={{ maximumFractionDigits: 0 }}
            value={form.stationIdleLockMinutes}
            onChange={(stationIdleLockMinutes) =>
              edit("stationIdleLockMinutes", { stationIdleLockMinutes })
            }
          />
          <NumberField
            label={t("settings.claimExpiry")}
            description={t("settings.claimExpiryHint")}
            name="claimExpiryMinutes"
            isRequired
            minValue={5}
            maxValue={480}
            formatOptions={{ maximumFractionDigits: 0 }}
            value={form.claimExpiryMinutes}
            onChange={(claimExpiryMinutes) => edit("claimExpiryMinutes", { claimExpiryMinutes })}
          />
        </div>

        <fieldset className="grid grid-cols-2 gap-x-4 sm:grid-cols-5">
          <legend className="mb-1 font-semibold">{t("settings.sla.title")}</legend>
          {stages.map((stage) => (
            <NumberField
              key={stage}
              label={t(`settings.sla.${stage}`)}
              name={`stageSlaMinutes.${stage}`}
              minValue={1}
              maxValue={10_080}
              formatOptions={{ maximumFractionDigits: 0 }}
              value={form.sla[stage]}
              onChange={(minutes) =>
                edit(`stageSlaMinutes.${stage}`, { sla: { ...form.sla, [stage]: minutes } })
              }
            />
          ))}
          <p className="col-span-full text-sm text-base-content/70">{t("settings.sla.hint")}</p>
        </fieldset>

        <RadioGroup
          label={t("settings.weightDisplay.label")}
          name="weightDisplay"
          value={form.weightDisplay}
          onChange={(value) => edit("weightDisplay", { weightDisplay: value as WeightDisplay })}
        >
          {(["LB_OZ", "LB_DECIMAL"] as const).map((display) => (
            <Radio key={display} value={display}>
              {t(`settings.weightDisplay.${display}`, {
                example: formatWeight(37, display, locale),
              })}
            </Radio>
          ))}
        </RadioGroup>

        <div className="grid gap-x-4 sm:grid-cols-2">
          <NumberField
            label={t("settings.piiRetention.label")}
            description={t("settings.piiRetention.hint")}
            name="piiRetentionDays"
            minValue={30}
            maxValue={3650}
            formatOptions={{ maximumFractionDigits: 0 }}
            value={form.piiRetentionDays}
            onChange={(piiRetentionDays) => edit("piiRetentionDays", { piiRetentionDays })}
          />
        </div>

        <Checkbox
          name="qaMustDifferFromPacker"
          isSelected={form.qaMustDifferFromPacker}
          onChange={(qaMustDifferFromPacker) =>
            edit("qaMustDifferFromPacker", { qaMustDifferFromPacker })
          }
        >
          {t("settings.qaMustDifferFromPacker")}
        </Checkbox>

        {save.error && (
          <p role="alert" className="text-error">
            {errorMessage(save.error)}
          </p>
        )}
        <div className="card-actions items-center justify-end">
          <p role="status" className="text-success">
            {save.isSuccess ? t("settings.saved") : ""}
          </p>
          <Button type="submit" isPending={save.isPending}>
            {t("common.save")}
          </Button>
        </div>
      </div>
    </Form>
  );
}
