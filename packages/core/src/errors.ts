import type { ErrorCode } from "@woolrus/i18n";

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
  ) {
    super(messageKey);
    this.name = "AppError";
  }
}

export const notFound = () => new AppError("NOT_FOUND", "errors.notFound");
export const forbidden = () => new AppError("FORBIDDEN", "errors.forbidden");
