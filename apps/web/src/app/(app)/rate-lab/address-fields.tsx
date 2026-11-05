"use client";

import { useTranslations } from "next-intl";
import { TextField } from "@/components/ui/fields";

// The ship-to fields of a test address and of a one-off quote (SPEC-rate-lab "UI"): the same
// fields, names and required set, so server field errors (`address.city`) land on them both.

export const addressFields = [
  "name",
  "company",
  "phone",
  "email",
  "address1",
  "address2",
  "city",
  "state",
  "postalCode",
  "country",
] as const;
export type AddressField = (typeof addressFields)[number];
export type AddressForm = Record<AddressField, string>;

export const requiredAddressFields = new Set<AddressField>([
  "name",
  "address1",
  "city",
  "postalCode",
  "country",
]);

/** A blank form, or `from`'s values; the country defaults to US. */
export function addressForm(from?: Partial<Record<AddressField, string | null>>): AddressForm {
  return Object.fromEntries(
    addressFields.map((f) => [f, from?.[f] ?? (f === "country" ? "US" : "")]),
  ) as AddressForm;
}

export function AddressFields({
  value,
  onChange,
  isDisabled = false,
  className = "grid grid-cols-2 gap-x-2",
}: {
  value: AddressForm;
  onChange: (value: AddressForm) => void;
  isDisabled?: boolean;
  className?: string;
}) {
  const t = useTranslations("rateLab.addresses");
  return (
    <fieldset className={className}>
      <legend className="fieldset-legend">{t("addressLegend")}</legend>
      {addressFields.map((field) => (
        <TextField
          key={field}
          label={t(`fields.${field}`)}
          name={`address.${field}`}
          type={field === "email" ? "email" : "text"}
          isRequired={requiredAddressFields.has(field)}
          isDisabled={isDisabled}
          value={value[field]}
          onChange={(next) => onChange({ ...value, [field]: next })}
        />
      ))}
    </fieldset>
  );
}
