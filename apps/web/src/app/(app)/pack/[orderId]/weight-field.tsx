"use client";

import { ORPCError } from "@orpc/client";
import type { WeightDisplay } from "@woolrus/contracts";
import { formatWeight } from "@woolrus/core/format";
import { poundsToOunces, splitPoundsOunces } from "@woolrus/core/units";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { Form } from "react-aria-components";
import { Dialog } from "@/components/ui/dialog";
import { Button, NumberField, TextAreaField } from "@/components/ui/fields";

// A package's weight in the display unit (SPEC-packing "UI", FR-PACK-04). The box's max sits
// beside it; a weight above it asks for a reason before anything saves (FR-PACK-09).

/** The box's max (oz) when the server refused a weight as over it; null for any other error. */
export function overweightMax(error: unknown): number | null {
  const data = error instanceof ORPCError ? (error.data as Record<string, unknown>) : undefined;
  const params = data?.params as { maxOz?: number } | undefined;
  return data?.messageKey === "errors.packing.overweight" ? (params?.maxOz ?? null) : null;
}

/** The typed fields as ounces: pounds + ounces, or decimal pounds. 0 or NaN reads as no weight. */
function toOunces(display: WeightDisplay, lb: number, oz: number): number {
  const pounds = Number.isNaN(lb) ? 0 : lb;
  const ounces = Number.isNaN(oz) ? 0 : oz;
  return display === "LB_DECIMAL"
    ? poundsToOunces(pounds)
    : Math.round((pounds * 16 + ounces) * 100) / 100;
}

export function WeightField({
  weightOz,
  maxWeightOz,
  weightDisplay,
  disabled,
  isPending,
  onSave,
}: {
  weightOz: number | null;
  maxWeightOz: number | null;
  weightDisplay: WeightDisplay;
  disabled: boolean;
  isPending: boolean;
  onSave: (weightOz: number) => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const initial =
    weightOz === null ? { lb: Number.NaN, oz: Number.NaN } : splitPoundsOunces(weightOz);
  const [lb, setLb] = useState(
    weightOz === null ? Number.NaN : weightDisplay === "LB_DECIMAL" ? weightOz / 16 : initial.lb,
  );
  const [oz, setOz] = useState(initial.oz);
  const total = toOunces(weightDisplay, lb, oz);

  return (
    <Form
      className="flex flex-wrap items-end gap-2"
      aria-label={t("pack.weight")}
      onSubmit={(event) => {
        event.preventDefault();
        if (total > 0) onSave(total);
      }}
    >
      <NumberField
        label={
          weightDisplay === "LB_DECIMAL"
            ? `${t("pack.weight")} (${t("pack.weightLb")})`
            : t("pack.weightLb")
        }
        minValue={0}
        maxValue={150}
        step={weightDisplay === "LB_DECIMAL" ? 0.01 : 1}
        isDisabled={disabled}
        value={lb}
        onChange={setLb}
        formatOptions={{ maximumFractionDigits: 2 }}
      />
      {weightDisplay === "LB_OZ" && (
        <NumberField
          label={t("pack.weightOz")}
          minValue={0}
          maxValue={15.99}
          step={0.1}
          isDisabled={disabled}
          value={oz}
          onChange={setOz}
          formatOptions={{ maximumFractionDigits: 2 }}
        />
      )}
      <Button
        type="submit"
        className="btn-outline"
        // Not disabled by the typed total: the field commits on blur, which a tap on this button causes.
        isDisabled={disabled}
        isPending={isPending}
      >
        {t("pack.weightSave")}
      </Button>
      {maxWeightOz !== null && (
        <span className="pb-3 text-sm" data-testid="pack-max">
          {t("pack.weightMax", { max: formatWeight(maxWeightOz, weightDisplay, locale) })}
        </span>
      )}
    </Form>
  );
}

/** Asks why a weight above the box's max should be kept; nothing saves without a reason. */
export function OverweightDialog({
  weightOz,
  maxOz,
  weightDisplay,
  isPending,
  onSave,
  onClose,
}: {
  weightOz: number;
  maxOz: number;
  weightDisplay: WeightDisplay;
  isPending: boolean;
  onSave: (reason: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [reason, setReason] = useState("");
  return (
    <Dialog title={t("pack.overTitle")} isOpen onOpenChange={(open) => !open && onClose()}>
      {(close) => (
        <Form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (reason.trim()) onSave(reason.trim());
          }}
        >
          <p>
            {t("pack.overHint", {
              weight: formatWeight(weightOz, weightDisplay, locale),
              max: formatWeight(maxOz, weightDisplay, locale),
            })}
          </p>
          <TextAreaField
            label={t("pack.overReason")}
            rows={3}
            isRequired
            maxLength={200}
            value={reason}
            onChange={setReason}
            autoFocus
          />
          <div className="modal-action">
            <Button className="btn-ghost" onPress={close}>
              {t("order.back")}
            </Button>
            <Button type="submit" className="btn-primary" isPending={isPending}>
              {t("pack.overSave")}
            </Button>
          </div>
        </Form>
      )}
    </Dialog>
  );
}
