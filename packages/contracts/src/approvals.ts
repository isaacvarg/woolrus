import { z } from "zod";
import { UnlockBadgeInput, UnlockPinInput } from "./stations";

// A second person's say-so for one action (SPEC-identity A2). It travels in the action's own input
// as an optional `approval` field; no procedure approves on its own (decision 16).

/**
 * Who is approving: a tile's user and their PIN, or a badge. The same shapes as the lock screen,
 * loose on purpose, so a malformed PIN is a wrong PIN and counts against the shared lockout.
 */
export const ApprovalCredential = z.union([
  UnlockPinInput,
  z.object({ badgeCode: UnlockBadgeInput.shape.code }),
]);
export type ApprovalCredential = z.infer<typeof ApprovalCredential>;

/** Every approval needs a reason (decision 22). */
export const ApprovalReason = z
  .string()
  .trim()
  .min(1, "errors.approval.reasonRequired")
  .max(200, "errors.approval.reasonRequired");

/** Embed as `approval: ApprovalInput.optional()` in an action that may need one. */
export const ApprovalInput = z.object({ credential: ApprovalCredential, reason: ApprovalReason });
export type ApprovalInput = z.infer<typeof ApprovalInput>;
