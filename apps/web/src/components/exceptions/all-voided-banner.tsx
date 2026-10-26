"use client";

import { useTranslations } from "next-intl";

/** Shown instead of Complete when every line is voided (FR-VOID-05): undo a void, or cancel. */
export function AllVoidedBanner() {
  const t = useTranslations();
  return (
    <div role="alert" className="alert alert-warning" data-testid="all-voided-banner">
      <span className="font-semibold">{t("voids.allVoided.title")}</span>
      <span>{t("voids.allVoided.hint")}</span>
    </div>
  );
}
