import type { ErrorCode } from "@woolrus/i18n";

// Lumexia failures callers act on (SPEC-lumexia "Adapter"). `detail` names the request, the status
// and Lumexia's error code, never the key or query values. A 400 is a bug on our side and is thrown
// as a plain Error, so it surfaces as an internal error rather than one of these.

abstract class LumexiaError extends Error {
  abstract readonly messageKey: ErrorCode;

  constructor(
    readonly detail: string,
    readonly status?: number,
  ) {
    super(detail);
  }
}

/** Network failure, timeout, 5xx or 429: try again later. Lots stay unverified meanwhile. */
export class LumexiaUnavailable extends LumexiaError {
  readonly messageKey = "errors.lumexia.unavailable";
  override readonly name = "LumexiaUnavailable";
}

/** 401 or 403: the key is missing, revoked, expired or lacks read scope. Retrying won't help. */
export class LumexiaAuthError extends LumexiaError {
  readonly messageKey = "errors.lumexia.unauthorized";
  override readonly name = "LumexiaAuthError";
}

/** The answer isn't Lumexia's API v1: a wrong URL, or Lumexia changed the contract. */
export class LumexiaBadResponse extends LumexiaError {
  readonly messageKey = "errors.lumexia.badResponse";
  override readonly name = "LumexiaBadResponse";
}

export function isLumexiaError(
  error: unknown,
): error is LumexiaUnavailable | LumexiaAuthError | LumexiaBadResponse {
  return error instanceof LumexiaError;
}
