"use client";

import type { WeightDisplay } from "@woolrus/contracts";
import { poundsToOunces, splitPoundsOunces } from "@woolrus/core/units";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { NumberField } from "@/components/ui/fields";

/** Ounces from the typed pounds (and ounces); null when nothing is typed or it totals zero. */
function toOunces(display: WeightDisplay, lb: number, oz: number): number | null {
  const pounds = Number.isNaN(lb) ? 0 : lb;
  const ounces = Number.isNaN(oz) ? 0 : oz;
  const total =
    display === "LB_DECIMAL"
      ? poundsToOunces(pounds)
      : Math.round((pounds * 16 + ounces) * 100) / 100;
  return total > 0 ? total : null;
}

/** A weight entered in the display unit (`Settings.weightDisplay`) and reported in ounces. */
export function WeightInput({
  label,
  valueOz,
  weightDisplay,
  onChange,
}: {
  label: string;
  valueOz: number | null;
  weightDisplay: WeightDisplay;
  onChange: (oz: number | null) => void;
}) {
  const t = useTranslations("boxes");
  const split = valueOz === null ? null : splitPoundsOunces(valueOz);
  const [lb, setLb] = useState(
    valueOz === null
      ? Number.NaN
      : weightDisplay === "LB_DECIMAL"
        ? valueOz / 16
        : (split?.lb ?? 0),
  );
  const [oz, setOz] = useState(split ? split.oz : Number.NaN);

  return (
    <div className="grid grid-cols-2 gap-x-2">
      <NumberField
        label={weightDisplay === "LB_DECIMAL" ? `${label} (${t("lb")})` : `${label} (${t("lb")})`}
        minValue={0}
        value={lb}
        onChange={(next) => {
          setLb(next);
          onChange(toOunces(weightDisplay, next, oz));
        }}
        formatOptions={{ maximumFractionDigits: 2 }}
      />
      {weightDisplay === "LB_OZ" && (
        <NumberField
          label={`${label} (${t("oz")})`}
          minValue={0}
          maxValue={15.99}
          value={oz}
          onChange={(next) => {
            setOz(next);
            onChange(toOunces(weightDisplay, lb, next));
          }}
          formatOptions={{ maximumFractionDigits: 2 }}
        />
      )}
    </div>
  );
}
