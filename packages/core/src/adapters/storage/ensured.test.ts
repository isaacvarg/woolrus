import { describe, expect, it } from "vitest";
import { ensureBucketOnFirstUse } from "./ensured";
import { createMemoryStorage } from "./memory";
import type { ObjectStorage } from "./storage";

const bytes = new Uint8Array([1, 2, 3]);

function counting(inner: ObjectStorage, failFirst = 0) {
  let calls = 0;
  const storage: ObjectStorage = {
    ...inner,
    async ensureBucket() {
      calls++;
      if (calls <= failFirst) throw new Error("storage down");
      await inner.ensureBucket();
    },
  };
  return { storage, calls: () => calls };
}

describe("ensureBucketOnFirstUse", () => {
  it("creates a missing bucket before the first call, once", async () => {
    const { storage, calls } = counting(createMemoryStorage({ bucketExists: false }));
    const ensured = ensureBucketOnFirstUse(storage);
    await Promise.all([ensured.put("a", bytes, "x/y"), ensured.put("b", bytes, "x/y")]);
    await ensured.get("a");
    expect(calls()).toBe(1);
  });

  it("tries again on the next use after a failure", async () => {
    const { storage, calls } = counting(createMemoryStorage({ bucketExists: false }), 1);
    const ensured = ensureBucketOnFirstUse(storage);
    await expect(ensured.put("a", bytes, "x/y")).rejects.toThrow("storage down");
    await ensured.put("a", bytes, "x/y");
    expect(calls()).toBe(2);
  });

  it("check counts as first use: it creates a missing bucket, then reports ok", async () => {
    const { storage, calls } = counting(createMemoryStorage({ bucketExists: false }));
    const ensured = ensureBucketOnFirstUse(storage);
    expect(await ensured.check()).toBe("ok");
    expect(await ensured.check()).toBe("ok");
    await ensured.put("a", bytes, "x/y");
    expect(calls()).toBe(1);
  });

  it("check reports fail when the bucket can't be ensured, and tries again next time", async () => {
    const { storage, calls } = counting(createMemoryStorage({ bucketExists: false }), 1);
    const ensured = ensureBucketOnFirstUse(storage);
    expect(await ensured.check()).toBe("fail");
    expect(await ensured.check()).toBe("ok");
    expect(calls()).toBe(2);
  });

  it("check gives up on a hanging ensure after the timeout", async () => {
    const inner = createMemoryStorage({ bucketExists: false });
    const hanging: ObjectStorage = { ...inner, ensureBucket: () => new Promise(() => {}) };
    const started = Date.now();
    expect(await ensureBucketOnFirstUse(hanging, { checkTimeoutMs: 50 }).check()).toBe("fail");
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
