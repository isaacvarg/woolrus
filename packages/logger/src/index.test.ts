import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { buildLogger, PII_KEYS } from "./index";

function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, done) {
      lines.push(JSON.parse(chunk.toString()));
      done();
    },
  });
  return { lines, log: buildLogger(stream) };
}

describe("redaction", () => {
  it("redacts PII keys one and two levels deep", () => {
    const { lines, log } = capture();
    log.info({ order: { customerEmail: "a@b.c", shippingAddress: { address_1: "1 Main" } } }, "x");
    log.info({ customerName: "Ann", ok: 1 }, "y");
    const order = lines[0]?.order as Record<string, unknown>;
    expect(order.customerEmail).toBe("[redacted]");
    expect(order.shippingAddress).toBe("[redacted]");
    expect(lines[1]?.customerName).toBe("[redacted]");
    expect(lines[1]?.ok).toBe(1);
  });

  it("redacts the usual spellings of a key, and the new WooCommerce keys", () => {
    const { lines, log } = capture();
    log.info(
      {
        Customer_Email: "a@b.c",
        CUSTOMER_NAME: "Ann",
        billing_phone: "1",
        username: "u",
        ip_address: "1.1.1.1",
        full_name: "A B",
      },
      "x",
    );
    for (const key of [
      "Customer_Email",
      "CUSTOMER_NAME",
      "billing_phone",
      "username",
      "ip_address",
      "full_name",
    ]) {
      expect(lines[0]?.[key]).toBe("[redacted]");
    }
  });

  it("still redacts secrets", () => {
    const { lines, log } = capture();
    log.info({ auth: { token: "t" } }, "x");
    const auth = lines[0]?.auth as Record<string, unknown>;
    expect(auth.token).toBe("[redacted]");
  });

  it("exports the PII key list", () => {
    expect(PII_KEYS).toContain("customerEmail");
    expect(PII_KEYS).toContain("shipToOriginal");
  });
});
