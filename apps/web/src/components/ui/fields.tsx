"use client";

// Thin wrappers that pair React Aria behaviour (labels, validation, keyboard, focus) with daisyUI styling.
import { useTranslations } from "next-intl";
import type { ReactNode, Ref } from "react";
import {
  Button as AriaButton,
  Checkbox as AriaCheckbox,
  NumberField as AriaNumberField,
  Radio as AriaRadio,
  RadioGroup as AriaRadioGroup,
  TextField as AriaTextField,
  type ButtonProps,
  type CheckboxProps,
  FieldError,
  Input,
  Label,
  type NumberFieldProps,
  type RadioGroupProps,
  type RadioProps,
  Text,
  type TextFieldProps,
} from "react-aria-components";

const focusRing = "outline-2 outline-offset-2 outline-primary";

/**
 * Field messages always come from the catalog: server errors arrive translated (see useFieldErrors),
 * and the browser's own checks (required, email format, range) are mapped to catalog messages
 * instead of showing the browser's wording in the browser's language.
 */
function AppFieldError({ isEmail = false }: { isEmail?: boolean }) {
  const t = useTranslations();
  return (
    <FieldError className="label whitespace-normal text-error">
      {({ validationErrors, validationDetails: check }) => {
        if (check.customError) return validationErrors.join(" ");
        if (check.valueMissing) return t("errors.field.required");
        if (check.typeMismatch && isEmail) return t("errors.field.email");
        if (check.rangeUnderflow) return t("errors.field.tooSmall");
        if (check.rangeOverflow) return t("errors.field.tooBig");
        return t("errors.field.invalid");
      }}
    </FieldError>
  );
}

export function Button({
  className = "btn-primary",
  ...props
}: ButtonProps & { className?: string; ref?: Ref<HTMLButtonElement> }) {
  return <AriaButton {...props} className={`btn ${className}`} />;
}

export function TextField({
  label,
  description,
  ...props
}: TextFieldProps & { label: string; description?: string }) {
  return (
    <AriaTextField {...props} className="fieldset">
      <Label className="fieldset-legend">{label}</Label>
      <Input className="input w-full" />
      {description && (
        <Text slot="description" className="label whitespace-normal">
          {description}
        </Text>
      )}
      <AppFieldError isEmail={props.type === "email"} />
    </AriaTextField>
  );
}

export function NumberField({
  label,
  description,
  ...props
}: NumberFieldProps & { label: string; description?: string }) {
  return (
    <AriaNumberField {...props} className="fieldset">
      <Label className="fieldset-legend">{label}</Label>
      <Input className="input w-full" />
      {description && (
        <Text slot="description" className="label whitespace-normal">
          {description}
        </Text>
      )}
      <AppFieldError />
    </AriaNumberField>
  );
}

export function Checkbox({
  children,
  ...props
}: Omit<CheckboxProps, "children"> & { children: ReactNode }) {
  return (
    <AriaCheckbox {...props} className="flex cursor-pointer items-center gap-2 py-2">
      {({ isSelected, isFocusVisible }) => (
        <>
          <span
            aria-hidden="true"
            className={`grid size-5 shrink-0 place-items-center rounded border-2 text-xs ${
              isSelected
                ? "border-primary bg-primary text-primary-content"
                : "border-base-content/40"
            } ${isFocusVisible ? focusRing : ""}`}
          >
            {isSelected && "✓"}
          </span>
          {children}
        </>
      )}
    </AriaCheckbox>
  );
}

export function RadioGroup({
  label,
  children,
  ...props
}: Omit<RadioGroupProps, "children"> & { label: string; children: ReactNode }) {
  return (
    <AriaRadioGroup {...props} className="fieldset">
      <Label className="fieldset-legend">{label}</Label>
      <div className="flex flex-wrap gap-x-6">{children}</div>
      <AppFieldError />
    </AriaRadioGroup>
  );
}

export function Radio({
  children,
  ...props
}: Omit<RadioProps, "children"> & { children: ReactNode }) {
  return (
    <AriaRadio {...props} className="flex cursor-pointer items-center gap-2 py-2">
      {({ isSelected, isFocusVisible }) => (
        <>
          <span
            aria-hidden="true"
            className={`size-5 shrink-0 rounded-full ${
              isSelected ? "border-6 border-primary" : "border-2 border-base-content/40"
            } ${isFocusVisible ? focusRing : ""}`}
          />
          {children}
        </>
      )}
    </AriaRadio>
  );
}
