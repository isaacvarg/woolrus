import type { LotDto } from "@woolrus/contracts";
import { lotLabel } from "@woolrus/core/lot-codes";
import { CircleAlert, CircleCheck, CircleHelp, CircleX } from "lucide-react";
import { useTranslations } from "next-intl";

const icons = {
  UNVERIFIED: CircleHelp,
  VALID: CircleCheck,
  NOT_FOUND: CircleAlert,
  WRONG_ITEM: CircleX,
} as const;

const tones = {
  UNVERIFIED: "text-base-content/70",
  VALID: "text-success",
  NOT_FOUND: "text-warning",
  WRONG_ITEM: "text-error",
} as const;

/**
 * A lot's Lumexia check as an icon and a word, never colour alone (SPEC-lumexia "Reads and UI").
 * Validation runs in the background, so a just-scanned lot shows "Unverified" until it's checked.
 */
export function LotStatus({
  status,
  warnUnverified = false,
}: {
  status: LotDto["status"];
  /**
   * QA shows UNVERIFIED as a warning, like NOT_FOUND (SPEC-lumexia "Reads and UI"). Elsewhere it
   * stays neutral: every lot is Unverified for a moment after it's scanned.
   */
  warnUnverified?: boolean;
}) {
  const t = useTranslations("lots.status");
  const Icon = icons[status];
  const tone = warnUnverified && status === "UNVERIFIED" ? "text-warning" : tones[status];
  return (
    <span className={`inline-flex items-center gap-1 ${tone}`} data-lot-status={status}>
      <Icon aria-hidden="true" className="size-4 shrink-0" />
      <span>{t(status)}</span>
    </span>
  );
}

/** A lot's short name ("A12A0124"), or "QR lot" while a QR code's lot isn't resolved. */
export function useLotText() {
  const t = useTranslations();
  return (lot: Pick<LotDto, "lotNumber">) =>
    lot.lotNumber ? lotLabel(lot.lotNumber) : t("pack.lotUnresolved");
}
