"use client";

// Thin wrappers that pair React Aria behaviour (labels, validation, keyboard, focus) with daisyUI styling.
import {
  Button as AriaButton,
  NumberField as AriaNumberField,
  TextField as AriaTextField,
  type ButtonProps,
  FieldError,
  Input,
  Label,
  type NumberFieldProps,
  type TextFieldProps,
} from "react-aria-components";

export function Button({
  className = "btn-primary",
  ...props
}: ButtonProps & { className?: string }) {
  return <AriaButton {...props} className={`btn ${className}`} />;
}

export function TextField({ label, ...props }: TextFieldProps & { label: string }) {
  return (
    <AriaTextField {...props} className="fieldset">
      <Label className="fieldset-legend">{label}</Label>
      <Input className="input w-full" />
      <FieldError className="label text-error" />
    </AriaTextField>
  );
}

export function NumberField({ label, ...props }: NumberFieldProps & { label: string }) {
  return (
    <AriaNumberField {...props} className="fieldset">
      <Label className="fieldset-legend">{label}</Label>
      <Input className="input w-full" />
      <FieldError className="label text-error" />
    </AriaNumberField>
  );
}
