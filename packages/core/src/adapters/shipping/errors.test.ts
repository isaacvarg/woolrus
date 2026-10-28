import { describe, expect, it } from "vitest";
import { ShippingError, shippingErrorFromCause, shippingErrorFromStatus } from "./errors";

describe("ShippingError", () => {
  it("keys its message by kind and is permanent unless it may work later", () => {
    expect(new ShippingError("unauthorized")).toMatchObject({
      messageKey: "errors.shipping.unauthorized",
      permanent: true,
    });
    expect(new ShippingError("rejected").permanent).toBe(true);
    expect(new ShippingError("unavailable").permanent).toBe(false);
    expect(new ShippingError("timeout")).toMatchObject({
      messageKey: "errors.shipping.timeout",
      permanent: false,
    });
  });
});

describe("shippingErrorFromStatus", () => {
  it.each([
    [401, "unauthorized"],
    [403, "unauthorized"],
    [400, "rejected"],
    [404, "rejected"],
    [422, "rejected"],
    [429, "unavailable"],
    [500, "unavailable"],
    [503, "unavailable"],
  ] as const)("maps %i to %s", (status, kind) => {
    const error = shippingErrorFromStatus("getRates", status);
    expect(error).toMatchObject({ kind, status, detail: `getRates ${status}` });
  });

  it("keeps the provider's error code when it is a plain token", () => {
    expect(shippingErrorFromStatus("purchaseLabel", 400, "invalid_postal_code").detail).toBe(
      "purchaseLabel 400 invalid_postal_code",
    );
  });

  it("drops a code that could be free text, an address or a key", () => {
    for (const code of ["123 Main Street", "Invalid key sk_live_abc", "a".repeat(65), "x\ny"]) {
      expect(shippingErrorFromStatus("ping", 400, code).detail).toBe("ping 400");
    }
  });
});

describe("shippingErrorFromCause", () => {
  it("maps a timeout or abort to timeout", () => {
    expect(
      shippingErrorFromCause("getRates", new DOMException("signal timed out", "TimeoutError")),
    ).toMatchObject({ kind: "timeout", detail: "getRates timeout" });
    expect(
      shippingErrorFromCause("getRates", new DOMException("aborted", "AbortError")),
    ).toMatchObject({
      kind: "timeout",
    });
  });

  it("maps anything else to unavailable without its message", () => {
    const error = shippingErrorFromCause(
      "ping",
      new TypeError("fetch failed: https://api.example/customers/C123?key=secret"),
    );
    expect(error).toMatchObject({ kind: "unavailable", detail: "ping network" });
    expect(error.message).not.toContain("secret");
  });

  it("passes a ShippingError through", () => {
    const original = new ShippingError("rejected", "x");
    expect(shippingErrorFromCause("ping", original)).toBe(original);
  });
});
