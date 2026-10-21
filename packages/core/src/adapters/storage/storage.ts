// Object storage for note attachments (SPEC-notes "Storage adapter"). S3-compatible in production
// (RustFS); tests use the in-memory one. Storage is infrastructure: configured from env, not Settings.

export type StoredObject = {
  body: ReadableStream<Uint8Array>;
  /** Bytes in `body` (the part's length for a ranged get); null when storage didn't say. */
  size: number | null;
  contentType: string;
  /** `bytes 0-99/1234` when a range was asked for, so the serving route can answer 206. */
  contentRange?: string;
};

export interface ObjectStorage {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** `range` is an HTTP `Range` header value (`bytes=0-99`), passed through as is. */
  get(key: string, range?: string): Promise<StoredObject>;
  /** Missing keys are not an error: a retried delete job finishes. */
  delete(keys: string[]): Promise<void>;
  /** Objects under `prefix` last modified before `olderThan` (for the orphan sweep). */
  list(prefix: string, olderThan: Date): AsyncIterable<{ key: string; lastModified: Date }>;
  /** Creates the bucket, private, if it doesn't exist. Safe to call again. */
  ensureBucket(): Promise<void>;
  /** For `/api/health`: the bucket exists and answers. Never throws. */
  check(): Promise<"ok" | "fail">;
}

export const storageErrorKinds = [
  "notFound",
  "invalidRange",
  "unauthorized",
  "rejected",
  "unavailable",
] as const;
export type StorageErrorKind = (typeof storageErrorKinds)[number];

/** A failed storage call. `unavailable` (5xx, network, timeout) may work later; jobs retry it. */
export class StorageError extends Error {
  constructor(
    readonly kind: StorageErrorKind,
    readonly detail?: string,
  ) {
    super(detail ? `${kind}: ${detail}` : kind);
    this.name = "StorageError";
  }
}
