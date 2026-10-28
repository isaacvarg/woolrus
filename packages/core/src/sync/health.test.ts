import type { Db } from "@woolrus/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoreAdapter } from "../adapters/woocommerce/adapter";
import { resetWooHealthCache, woocommerceHealth } from "./health";

const db = {} as Db;
const storeWith = (ping: () => Promise<void>) =>
  vi.fn(async () => ({ ping }) as unknown as StoreAdapter);

beforeEach(() => resetWooHealthCache());

describe("woocommerceHealth", () => {
  it("reports ok when the store answers", async () => {
    const store = storeWith(async () => {});
    expect(await woocommerceHealth(db, { store })).toBe("ok");
  });

  it("reports fail when the store is down", async () => {
    const store = storeWith(async () => {
      throw new Error("ECONNREFUSED shop.example.com");
    });
    expect(await woocommerceHealth(db, { store })).toBe("fail");
  });

  it("reports fail when the ping outlasts the timeout", async () => {
    const store = storeWith(() => new Promise<void>(() => {}));
    expect(await woocommerceHealth(db, { store, timeoutMs: 20 })).toBe("fail");
  });

  it("reports unconfigured when no store is set up", async () => {
    expect(await woocommerceHealth(db, { store: async () => null })).toBe("unconfigured");
  });

  it("reports fail when the store config can't be read", async () => {
    const store = vi.fn(async () => {
      throw new Error("bad key");
    });
    expect(await woocommerceHealth(db, { store })).toBe("fail");
  });

  it("doesn't ping again within 30 s, then does", async () => {
    const ping = vi.fn(async () => {});
    const store = storeWith(ping);
    await woocommerceHealth(db, { store, now: 1_000 });
    await woocommerceHealth(db, { store, now: 30_999 });
    expect(ping).toHaveBeenCalledTimes(1);
    await woocommerceHealth(db, { store, now: 31_000 });
    expect(ping).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight ping between concurrent calls", async () => {
    const ping = vi.fn(async () => {});
    const store = storeWith(ping);
    await Promise.all([woocommerceHealth(db, { store }), woocommerceHealth(db, { store })]);
    expect(ping).toHaveBeenCalledTimes(1);
  });
});
