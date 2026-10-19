"use client";

import { useTranslations } from "next-intl";

/**
 * Reasons are what a person typed, except those store sync writes (stage events, holds), which are
 * message keys under `sync.reason.` so they read in the viewer's language.
 */
export function useReasonText() {
  const t = useTranslations();
  return (reason: string): string =>
    reason.startsWith("sync.reason.") && t.has(reason) ? t(reason as never) : reason;
}
