"use client";

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { NumberField, Radio, RadioGroup, SelectField } from "@/components/ui/fields";

// A parcel's size, from a box (its inner size is copied) or typed: the test parcel form and the
// Quote tab's typed parcels share it (SPEC-rate-lab "Addresses and parcels").

export type Side = "lengthIn" | "widthIn" | "heightIn";
export type SizeSource = "box" | "typed";
export type TypedSize = Record<Side, number>;

const sides: { key: Side; label: "length" | "width" | "height" }[] = [
  { key: "lengthIn", label: "length" },
  { key: "widthIn", label: "width" },
  { key: "heightIn", label: "height" },
];

export const blankSize = (): TypedSize => ({
  lengthIn: Number.NaN,
  widthIn: Number.NaN,
  heightIn: Number.NaN,
});

export function ParcelSizeFields({
  namePrefix,
  source,
  onSourceChange,
  boxId,
  onBoxChange,
  boxOptions,
  size,
  onSizeChange,
  isDisabled = false,
  boxHint,
}: {
  /** The field path the server's errors use: `size` or `adHocParcels.0.size`. */
  namePrefix: string;
  source: SizeSource;
  onSourceChange: (source: SizeSource) => void;
  boxId: string | null;
  onBoxChange: (boxId: string | null) => void;
  boxOptions: { id: string; label: string }[];
  size: TypedSize;
  onSizeChange: (size: TypedSize) => void;
  isDisabled?: boolean;
  /** Shown under the box picker, e.g. the chosen box's size. */
  boxHint?: ReactNode;
}) {
  const t = useTranslations("rateLab.parcels");
  return (
    <>
      <RadioGroup
        label={t("sizeSource")}
        value={source}
        onChange={(value) => onSourceChange(value as SizeSource)}
        isDisabled={isDisabled}
      >
        <Radio value="box">{t("fromBox")}</Radio>
        <Radio value="typed">{t("typed")}</Radio>
      </RadioGroup>
      {source === "box" ? (
        <>
          <SelectField
            label={t("box")}
            name={`${namePrefix}.boxId`}
            isRequired
            isDisabled={isDisabled}
            selectedKey={boxId}
            onSelectionChange={(key) => onBoxChange(key === null ? null : String(key))}
            options={boxOptions}
          />
          {boxHint}
        </>
      ) : (
        <div className="grid grid-cols-3 gap-x-2">
          {sides.map(({ key, label }) => (
            <NumberField
              key={key}
              label={t(label)}
              name={`${namePrefix}.${key}`}
              isRequired
              isDisabled={isDisabled}
              minValue={0.01}
              value={size[key]}
              onChange={(value) => onSizeChange({ ...size, [key]: value })}
            />
          ))}
        </div>
      )}
    </>
  );
}
