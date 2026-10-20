"use client";

import { ORPCError } from "@orpc/client";
import { useTranslations } from "next-intl";

function errorData(
  error: unknown,
): { messageKey?: unknown; fields?: unknown; params?: unknown } | undefined {
  return error instanceof ORPCError
    ? (error.data as Record<string, unknown> | undefined)
    : undefined;
}

// Times travel as ISO strings ("try again at {until, time, short}"); ICU formats only Dates.
const isoTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
function revive(params: object): never {
  return Object.fromEntries(
    Object.entries(params).map(([name, value]) => [
      name,
      typeof value === "string" && isoTime.test(value) ? new Date(value) : value,
    ]),
  ) as never;
}

/** Translates any API error into the user's language using the error's message key. */
export function useErrorMessage() {
  const t = useTranslations();
  return (error: unknown): string => {
    // Every API error the server raises on purpose carries data.messageKey (see @woolrus/contracts),
    // and `params` for messages that name something ("{name} is working on this order.").
    const { messageKey: key, params } = errorData(error) ?? {};
    if (typeof key === "string" && t.has(key)) {
      return t(key, typeof params === "object" && params !== null ? revive(params) : undefined);
    }
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
