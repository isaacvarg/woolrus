"use client";

import { useTranslations } from "next-intl";
import type { Ref } from "react";
import { Button } from "@/components/ui/fields";

export const PIN_LENGTH = 6;
const PAD = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

/** Keeps digits only, at most `PIN_LENGTH` of them. */
export function pinDigits(value: string): string {
  return value.replace(/\D/g, "").slice(0, PIN_LENGTH);
}

/**
 * A PIN field with a touch keypad (tablet targets, ≥ 48 px), shared by the station lock screen
 * and the approval dialog (SPEC-identity "UI"). Controlled: `onChange` gets the next digits, and
 * the caller decides what a full PIN does.
 */
export function PinPad({
  id,
  label,
  value,
  onChange,
  isDisabled = false,
  inputRef,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (digits: string) => void;
  isDisabled?: boolean;
  inputRef?: Ref<HTMLInputElement>;
}) {
  const t = useTranslations("station");
  const enter = (next: string) => onChange(pinDigits(next));
  const key = "btn-outline h-20 text-3xl";
  return (
    <div className="flex w-full max-w-sm flex-col items-center gap-4">
      <label htmlFor={id} className="text-2xl font-semibold">
        {label}
      </label>
      <input
        ref={inputRef}
        id={id}
        type="password"
        inputMode="numeric"
        autoComplete="off"
        maxLength={PIN_LENGTH}
        value={value}
        disabled={isDisabled}
        onChange={(e) => enter(e.target.value)}
        className="input input-lg w-full text-center text-3xl tracking-[0.5em]"
      />
      <div className="grid w-full grid-cols-3 gap-3">
        {PAD.map((digit) => (
          <Button
            key={digit}
            className={key}
            isDisabled={isDisabled}
            onPress={() => enter(value + digit)}
          >
            {digit}
          </Button>
        ))}
        <Button className="btn-ghost h-20" isDisabled={isDisabled} onPress={() => enter("")}>
          {t("clear")}
        </Button>
        <Button className={key} isDisabled={isDisabled} onPress={() => enter(`${value}0`)}>
          0
        </Button>
        <Button
          className="btn-ghost h-20"
          isDisabled={isDisabled}
          onPress={() => enter(value.slice(0, -1))}
        >
          {t("backspace")}
        </Button>
      </div>
    </div>
  );
}
