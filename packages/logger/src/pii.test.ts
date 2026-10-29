import { describe, expect, it } from "vitest";
import { isPiiKey, isPiiMetaPair, maskEmails, PII_KEYS } from "./pii";

describe("isPiiKey", () => {
  it.each([...PII_KEYS, "Customer_Email", "CUSTOMER-NOTE", "Billing_Phone"])(
    "matches %s",
    (key) => {
      expect(isPiiKey(key)).toBe(true);
    },
  );

  it.each(["id", "status", "postcode", "country", "total", "sku"])("leaves %s alone", (key) => {
    expect(isPiiKey(key)).toBe(false);
  });
});

describe("isPiiMetaPair", () => {
  it("is true when the key or display_key names PII", () => {
    expect(isPiiMetaPair({ key: "billing_phone", value: "1" })).toBe(true);
    expect(isPiiMetaPair({ display_key: "Phone", value: "1" })).toBe(true);
    expect(isPiiMetaPair({ key: "Gift message", value: "x" })).toBe(false);
  });
});

describe("maskEmails", () => {
  it("masks an address in running text", () => {
    expect(maskEmails("bounce for ann@example.com today")).toBe("bounce for [redacted] today");
  });

  it("keeps only the first 2000 characters", () => {
    const out = maskEmails(`${"a ".repeat(1500)}ann@example.com`);
    expect(out.length).toBeLessThanOrEqual(2001);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toContain("ann@");
  });

  it("masks a 64-character local part and doesn't match a 65-character one whole", () => {
    expect(maskEmails(`${"a".repeat(64)}@example.com`)).toBe("[redacted]");
    expect(maskEmails(`${"a".repeat(65)}@example.com`)).toBe(`a[redacted]`);
  });

  it("stays linear on adversarial input", () => {
    const started = performance.now();
    maskEmails(`${"a@".repeat(1000)}${"b".repeat(1000)}`);
    expect(performance.now() - started).toBeLessThan(100);
  });
});
