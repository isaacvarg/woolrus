import { type ObjectStorage, StorageError, type StoredObject } from "./storage";

type Entry = { body: Uint8Array; contentType: string; lastModified: Date };

export type MemoryStorageOptions = {
  /** Start with no bucket, to exercise `ensureBucket` (default: it exists). */
  bucketExists?: boolean;
  now?: () => Date;
};

export type MemoryStorage = ObjectStorage & {
  /** For assertions: the stored keys, sorted. */
  keys(): string[];
};

/**
 * Parses `bytes=a-b`, `bytes=a-` and `bytes=-n` against `size`, the forms S3 accepts for one range.
 * An unsatisfiable range throws `invalidRange`, as S3's 416 does.
 */
function parseRange(range: string, size: number): { start: number; end: number } {
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match || (match[1] === "" && match[2] === "")) {
    throw new StorageError("invalidRange", range);
  }
  const [, from, to] = match;
  let start: number;
  let end: number;
  if (from === "") {
    start = Math.max(0, size - Number(to));
    end = size - 1;
  } else {
    start = Number(from);
    end = to === "" ? size - 1 : Math.min(Number(to), size - 1);
  }
  if (start >= size || start > end) throw new StorageError("invalidRange", range);
  return { start, end };
}

/** In-process storage with S3's semantics, for tests. */
export function createMemoryStorage(options: MemoryStorageOptions = {}): MemoryStorage {
  const now = options.now ?? (() => new Date());
  const objects = new Map<string, Entry>();
  let bucketExists = options.bucketExists ?? true;

  const requireBucket = () => {
    if (!bucketExists) throw new StorageError("notFound", "bucket");
  };

  return {
    async put(key, body, contentType) {
      requireBucket();
      objects.set(key, { body: body.slice(), contentType, lastModified: now() });
    },

    async get(key, range): Promise<StoredObject> {
      requireBucket();
      const entry = objects.get(key);
      if (!entry) throw new StorageError("notFound", key);
      let bytes = entry.body;
      let contentRange: string | undefined;
      if (range !== undefined) {
        const { start, end } = parseRange(range, entry.body.length);
        bytes = entry.body.slice(start, end + 1);
        contentRange = `bytes ${start}-${end}/${entry.body.length}`;
      }
      return {
        body: new Blob([new Uint8Array(bytes)]).stream(),
        size: bytes.length,
        contentType: entry.contentType,
        contentRange,
      };
    },

    async delete(keys) {
      requireBucket();
      for (const key of keys) objects.delete(key);
    },

    async *list(prefix, olderThan) {
      requireBucket();
      for (const [key, entry] of [...objects].sort(([a], [b]) => a.localeCompare(b))) {
        if (key.startsWith(prefix) && entry.lastModified < olderThan) {
          yield { key, lastModified: entry.lastModified };
        }
      }
    },

    async ensureBucket() {
      bucketExists = true;
    },

    async check() {
      return bucketExists ? "ok" : "fail";
    },

    keys: () => [...objects.keys()].sort(),
  };
}
