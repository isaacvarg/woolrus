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
  Switch as AriaSwitch,
  TextField as AriaTextField,
  type ButtonProps,
  type CheckboxProps,
  FieldError,
  Input,
  Label,
  type NumberFieldProps,
  type RadioGroupProps,
  type RadioProps,
  type SwitchProps,
  Text,
  TextArea,
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

/** Multi-line text, e.g. a note. */
export function TextAreaField({
  label,
  description,
  rows = 4,
  ...props
}: TextFieldProps & { label: string; description?: string; rows?: number }) {
  return (
    <AriaTextField {...props} className="fieldset">
      <Label className="fieldset-legend">{label}</Label>
      <TextArea className="textarea w-full text-base" rows={rows} />
      {description && (
        <Text slot="description" className="label whitespace-normal">
          {description}
        </Text>
      )}
      <AppFieldError />
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

/** An on/off toggle that applies at once (no form submit), e.g. enabling a rule. */
export function Switch({
  children,
  ...props
}: Omit<SwitchProps, "children"> & { children: ReactNode }) {
  return (
    <AriaSwitch {...props} className="flex cursor-pointer items-center gap-2 py-2">
      {({ isSelected, isFocusVisible }) => (
        <>
          <span
            aria-hidden="true"
            className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
              isSelected ? "bg-primary" : "bg-base-content/30"
            } ${isFocusVisible ? focusRing : ""}`}
          >
            <span
              className={`absolute top-0.5 size-5 rounded-full bg-base-100 shadow transition-transform ${
                isSelected ? "translate-x-5.5" : "translate-x-0.5"
              }`}
            />
          </span>
          {children}
        </>
      )}
    </AriaSwitch>
  );
}
