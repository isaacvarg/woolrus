import { oc } from "@orpc/contract";
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
