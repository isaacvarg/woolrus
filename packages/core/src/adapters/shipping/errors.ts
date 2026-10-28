import type { ErrorCode } from "@woolrus/i18n";

export const shippingErrorKinds = ["unauthorized", "rejected", "unavailable", "timeout"] as const;
export type ShippingErrorKind = (typeof shippingErrorKinds)[number];

/**
 * A provider call that failed. `unavailable` (429, 5xx, network) and `timeout` may work later, so
 * jobs retry them; the others are permanent. `detail` names the operation, the status and the
 * provider's error code, never credentials, addresses or the provider's free text (which can echo
 * the request). Build it with `shippingErrorFromStatus` / `shippingErrorFromCause`.
 */
export class ShippingError extends Error {
  readonly messageKey: ErrorCode;
  readonly permanent: boolean;

  constructor(
    readonly kind: ShippingErrorKind,
    readonly detail?: string,
    readonly status?: number,
  ) {
    super(detail ? `${kind}: ${detail}` : kind);
    this.name = "ShippingError";
    this.messageKey = `errors.shipping.${kind}`;
    this.permanent = kind === "unauthorized" || kind === "rejected";
  }
}

/** A provider error code worth logging: one short token, so it can't carry free text. */
const ERROR_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** An HTTP error response: 401/403 unauthorized, 429 and 5xx unavailable, other 4xx rejected. */
export function shippingErrorFromStatus(
  operation: string,
  status: number,
  code?: string,
): ShippingError {
  const kind: ShippingErrorKind =
    status === 401 || status === 403
      ? "unauthorized"
      : status === 429 || status >= 500
        ? "unavailable"
        : "rejected";
  const token = code && ERROR_CODE.test(code) ? ` ${code}` : "";
  return new ShippingError(kind, `${operation} ${status}${token}`, status);
}

/** A call that threw before a response: a timeout or abort, or a network failure. */
export function shippingErrorFromCause(operation: string, cause: unknown): ShippingError {
  if (cause instanceof ShippingError) return cause;
  const timedOut =
    cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
  return timedOut
    ? new ShippingError("timeout", `${operation} timeout`)
    : new ShippingError("unavailable", `${operation} network`);
}
