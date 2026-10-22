import type { ErrorCode } from "@woolrus/i18n";

/** One thing a workflow gate still needs, e.g. `errors.workflow.gate.lineUnderPacked` with `{ line, packed, expected }`. */
export type UnmetCondition = { messageKey: ErrorCode; params: Record<string, string | number> };

/** One order a batch operation couldn't handle, e.g. a claim refused because someone else holds it. */
export type OrderFailure = {
  orderId: string;
  messageKey: ErrorCode;
  params: Record<string, string | number>;
};

export type AppErrorKind = "UNAUTHORIZED" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "BAD_REQUEST";

/**
 * The only error type domain code throws on purpose. The API layer maps it to an oRPC error;
 * `messageKey` is translated by the client.
 */
export class AppError extends Error {
  constructor(
    readonly kind: AppErrorKind,
    readonly messageKey: ErrorCode,
    readonly fields?: Record<string, ErrorCode>,
    details: {
      /** Values for the message, e.g. the claim holder's name. */
      params?: Record<string, string | number>;
      /** What a workflow gate still needs. */
      unmet?: readonly UnmetCondition[];
      /** Per-order failures of an all-or-nothing batch. */
      failures?: readonly OrderFailure[];
      /** An unknown scanned code the caller may link to a product (SPEC-picking "Code matching"). */
      canLink?: boolean;
    } = {},
  ) {
    super(messageKey);
    this.name = "AppError";
    this.params = details.params;
    this.unmet = details.unmet;
    this.failures = details.failures;
    this.canLink = details.canLink;
  }

  readonly params?: Record<string, string | number>;
  readonly unmet?: readonly UnmetCondition[];
  readonly failures?: readonly OrderFailure[];
  readonly canLink?: boolean;
}

export const notFound = () => new AppError("NOT_FOUND", "errors.notFound");
export const forbidden = () => new AppError("FORBIDDEN", "errors.forbidden");
