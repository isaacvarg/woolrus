"use client";

import { ORPCError } from "@orpc/client";
import { useTranslations } from "next-intl";

/** Translates any API error into the user's language using the error's message key. */
export function useErrorMessage() {
  const t = useTranslations();
  return (error: unknown): string => {
    // Every API error the server raises on purpose carries data.messageKey (see @woolrus/contracts).
    const key =
      error instanceof ORPCError
        ? (error.data as { messageKey?: unknown } | undefined)?.messageKey
        : undefined;
    if (typeof key === "string" && t.has(key)) return t(key);
    return t("errors.internal");
  };
}
