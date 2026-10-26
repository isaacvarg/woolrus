"use client";

import type { ItemVoidView } from "@woolrus/contracts";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/fields";

/**
 * One void under its line: "1 of 3 voided: out of stock", with Undo while nobody has dealt with
 * it in the store (SPEC-exceptions FR-VOID-03). Callbacks only, so other screens embed it as is.
 */
export function VoidRow({
  voided,
  lineQuantity,
  onUndo,
  isPending = false,
}: {
  voided: ItemVoidView;
  lineQuantity: number;
  /** Omit when the caller can't undo (no permission, order closed). */
  onUndo?: (voided: ItemVoidView) => void;
  isPending?: boolean;
}) {
  const t = useTranslations();
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="void-row">
      <span className="font-medium text-error">
        {t("voids.summary", { count: voided.quantity, total: lineQuantity, reason: voided.reason })}
      </span>
      {voided.resolvedAt && <span className="badge badge-ghost">{t("voids.resolved")}</span>}
      {onUndo && !voided.resolvedAt && (
        <Button className="btn-outline btn-sm" isPending={isPending} onPress={() => onUndo(voided)}>
          {t("voids.undo")}
        </Button>
      )}
    </div>
  );
}
