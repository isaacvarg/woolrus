import { oc } from "@orpc/contract";
import { type ErrorCode, isErrorCode } from "@woolrus/i18n";
import { z } from "zod";

/**
 * Every API error carries a message key from @woolrus/i18n ("errors.box.inUse"), never English.
 * Clients translate it; `fields` maps form fields to message keys for validation errors.
 */
export const AppErrorData = z.object({
  messageKey: z.string(),
  fields: z.record(z.string(), z.string()).optional(),
});
export type AppErrorData = z.infer<typeof AppErrorData>;

export const base = oc.errors({
  UNAUTHORIZED: { data: AppErrorData },
  FORBIDDEN: { data: AppErrorData },
  NOT_FOUND: { data: AppErrorData },
  CONFLICT: { data: AppErrorData },
  BAD_REQUEST: { data: AppErrorData },
});

/** The parts of a Standard Schema issue we use; Zod's issues also carry a `code`. */
type Issue = {
  message: string;
  path?: readonly (PropertyKey | { key: PropertyKey })[];
  code?: string;
};

const keyByCode: Record<string, ErrorCode> = {
  too_small: "errors.field.tooSmall",
  too_big: "errors.field.tooBig",
};

/**
 * Turns validation issues into `fields` for AppErrorData: dotted path -> message key. Schemas may
 * use a catalog key as their message; otherwise Zod's English message is replaced by a generic
 * key for its issue code, so no English reaches the client.
 */
export function toFieldErrors(issues: readonly Issue[]): Record<string, ErrorCode> {
  const fields: Record<string, ErrorCode> = {};
  for (const issue of issues) {
    if (!issue.path?.length) continue;
    const path = issue.path
      .map((segment) => String(typeof segment === "object" ? segment.key : segment))
      .join(".");
    if (path in fields) continue;
    fields[path] = isErrorCode(issue.message)
      ? issue.message
      : (keyByCode[issue.code ?? ""] ?? "errors.field.invalid");
  }
  return fields;
}

export const Id = z.uuid();

/**
 * Header-free idempotency: mutations that create things take a client-generated key so a
 * replayed request returns the original result (flaky Wi-Fi, future offline Android client).
 */
export const IdempotencyKey = z.string().min(8).max(100);

/** Inches, up to 2 decimals. */
export const Inches = z.number().positive().max(999).multipleOf(0.01);
/** Ounces, up to 2 decimals. */
export const Ounces = z.number().positive().max(99_999).multipleOf(0.01);
