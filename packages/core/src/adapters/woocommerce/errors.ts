import type { ErrorCode } from "@woolrus/i18n";

export const storeErrorKinds = [
  "unauthorized",
  "notFound",
  "unreachable",
  "notWooCommerce",
  "rateLimited",
  "badResponse",
] as const;

export type StoreErrorKind = (typeof storeErrorKinds)[number];

export function storeErrorMessageKey(kind: StoreErrorKind): ErrorCode {
  return `errors.sync.${kind}`;
}

/**
 * A WooCommerce call that failed. `detail` is for the sync log and server logs: it names the
 * request and status or the schema path that failed, never credentials or payload values.
 */
export class StoreError extends Error {
  readonly messageKey: ErrorCode;

  constructor(
    readonly kind: StoreErrorKind,
    readonly detail?: string,
    readonly status?: number,
  ) {
    super(detail ? `${kind}: ${detail}` : kind);
    this.name = "StoreError";
    this.messageKey = storeErrorMessageKey(kind);
  }
}
