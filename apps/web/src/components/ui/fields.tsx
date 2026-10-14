"use client";

// Thin wrappers that pair React Aria behaviour (labels, validation, keyboard, focus) with daisyUI styling.
import type { ReactNode } from "react";
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

export function Button({
  className = "btn-primary",
  ...props
}: ButtonProps & { className?: string }) {
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
      <FieldError className="label text-error" />
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
      <FieldError className="label text-error" />
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
      <FieldError className="label text-error" />
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
