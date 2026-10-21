import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ObjectStorage, StorageError } from "./storage";

// The behaviour every ObjectStorage shares, run against MemoryStorage in CI and against the dev
// RustFS in the opt-in live test, so the fake can't drift from the real thing.

export type StorageFixture = {
  /** A storage whose bucket doesn't exist yet. */
  storage: ObjectStorage;
  cleanup?: () => Promise<void>;
};

const text = (s: string) => new TextEncoder().encode(s);

async function readAll(body: ReadableStream<Uint8Array>): Promise<string> {
  return new TextDecoder().decode(await new Response(body).arrayBuffer());
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of items) out.push(item);
  return out;
}

export function describeObjectStorage(name: string, setup: () => Promise<StorageFixture>) {
  describe(`${name} (ObjectStorage)`, () => {
    let fixture: StorageFixture;
    let storage: ObjectStorage;
    const prefix = `suite-${crypto.randomUUID()}/`;

    beforeAll(async () => {
      fixture = await setup();
      storage = fixture.storage;
    });
    afterAll(async () => {
      await fixture?.cleanup?.();
    });

    it("ensures a fresh bucket: check fails before and passes after, and a second ensure is fine", async () => {
      expect(await storage.check()).toBe("fail");
      await storage.ensureBucket();
      expect(await storage.check()).toBe("ok");
      await storage.ensureBucket();
      expect(await storage.check()).toBe("ok");
    });

    it("puts and gets an object with its content type and size", async () => {
      await storage.put(`${prefix}a.txt`, text("hello storage"), "text/plain");
      const object = await storage.get(`${prefix}a.txt`);
      expect(object.contentType).toBe("text/plain");
      expect(object.size).toBe(13);
      expect(object.contentRange).toBeUndefined();
      expect(await readAll(object.body)).toBe("hello storage");
    });

    it("gets a byte range and reports the content range", async () => {
      await storage.put(`${prefix}range.bin`, text("0123456789"), "application/octet-stream");
      const head = await storage.get(`${prefix}range.bin`, "bytes=0-3");
      expect(head.size).toBe(4);
      expect(head.contentRange).toBe("bytes 0-3/10");
      expect(await readAll(head.body)).toBe("0123");
      const tail = await storage.get(`${prefix}range.bin`, "bytes=7-");
      expect(tail.contentRange).toBe("bytes 7-9/10");
      expect(await readAll(tail.body)).toBe("789");
    });

    it("refuses a range past the end", async () => {
      await storage.put(`${prefix}short.bin`, text("abc"), "application/octet-stream");
      await expect(storage.get(`${prefix}short.bin`, "bytes=10-20")).rejects.toMatchObject({
        kind: "invalidRange",
      });
    });

    it("reports a missing object as notFound", async () => {
      const error = await storage.get(`${prefix}missing`).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(StorageError);
      expect(error).toMatchObject({ kind: "notFound" });
    });

    it("lists objects under a prefix by age", async () => {
      const dir = `${prefix}list/`;
      await storage.put(`${dir}one`, text("1"), "text/plain");
      await storage.put(`${dir}two`, text("2"), "text/plain");
      await storage.put(`${prefix}elsewhere`, text("3"), "text/plain");

      const future = new Date(Date.now() + 60_000);
      const listed = await collect(storage.list(dir, future));
      expect(listed.map((o) => o.key).sort()).toEqual([`${dir}one`, `${dir}two`]);
      for (const o of listed) expect(o.lastModified).toBeInstanceOf(Date);

      const past = new Date(Date.now() - 60 * 60_000);
      expect(await collect(storage.list(dir, past))).toEqual([]);
    });

    it("deletes objects, treating missing keys as success", async () => {
      await storage.put(`${prefix}del-1`, text("x"), "text/plain");
      await storage.put(`${prefix}del-2`, text("y"), "text/plain");
      await storage.delete([`${prefix}del-1`, `${prefix}del-2`, `${prefix}never-existed`]);
      await expect(storage.get(`${prefix}del-1`)).rejects.toMatchObject({ kind: "notFound" });
      await expect(storage.get(`${prefix}del-2`)).rejects.toMatchObject({ kind: "notFound" });
      await storage.delete([`${prefix}del-1`]);
      await storage.delete([]);
    });
  });
}
