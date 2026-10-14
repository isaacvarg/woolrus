"use client";

import { ORPCError } from "@orpc/client";
import { useTranslations } from "next-intl";

function errorData(error: unknown): { messageKey?: unknown; fields?: unknown } | undefined {
  return error instanceof ORPCError
    ? (error.data as Record<string, unknown> | undefined)
    : undefined;
}

/** Translates any API error into the user's language using the error's message key. */
export function useErrorMessage() {
  const t = useTranslations();
  return (error: unknown): string => {
    // Every API error the server raises on purpose carries data.messageKey (see @woolrus/contracts).
    const key = errorData(error)?.messageKey;
    if (typeof key === "string" && t.has(key)) return t(key);
    return t("errors.internal");
  };
}

/**
 * Translated per-field messages from a validation error, keyed by field path ("shipFrom.state").
 * Pass the result to React Aria's `<Form validationErrors>`; fields match by their `name`.
 */
export function useFieldErrors() {
  const t = useTranslations();
  return (error: unknown): Record<string, string> => {
    const fields = errorData(error)?.fields;
    if (typeof fields !== "object" || fields === null) return {};
    return Object.fromEntries(
      Object.entries(fields).map(([field, key]) => [
        field,
        typeof key === "string" && t.has(key) ? t(key) : t("errors.field.invalid"),
      ]),
    );
  };
}
