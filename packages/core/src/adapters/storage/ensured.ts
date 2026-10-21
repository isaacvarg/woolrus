import type { ObjectStorage } from "./storage";

export type EnsureOptions = {
  /** How long `check()` waits for a first ensure; matches the HEAD-bucket timeout of health. */
  checkTimeoutMs?: number;
};

/**
 * The bucket is created when it's first needed (SPEC-notes: on worker start, and on first use in
 * web), so a fresh install needs no manual step. Memoized; a failure clears the memo so the next
 * call tries again.
 */
export function ensureBucketOnFirstUse(
  storage: ObjectStorage,
  options: EnsureOptions = {},
): ObjectStorage {
  const checkTimeoutMs = options.checkTimeoutMs ?? 2_000;
  let ready: Promise<void> | undefined;
  let ensured = false;
  const ensure = () => {
    ready ??= storage.ensureBucket().then(
      () => {
        ensured = true;
      },
      (error: unknown) => {
        ready = undefined;
        throw error;
      },
    );
    return ready;
  };

  return {
    ensureBucket: ensure,

    // Health is often web's first use (and the only one in CI, which runs no worker), so a
    // missing bucket is created here rather than reported as down. A hanging ensure still answers
    // "fail" within the timeout; the ensure carries on and the next check sees its result.
    async check() {
      if (!ensured) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const ok = await Promise.race([
          ensure().then(
            () => true,
            () => false,
          ),
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), checkTimeoutMs);
          }),
        ]);
        clearTimeout(timer);
        if (!ok) return "fail";
      }
      return storage.check();
    },

    async put(key, body, contentType) {
      await ensure();
      return storage.put(key, body, contentType);
    },
    async get(key, range) {
      await ensure();
      return storage.get(key, range);
    },
    async delete(keys) {
      await ensure();
      return storage.delete(keys);
    },
    async *list(prefix, olderThan) {
      await ensure();
      yield* storage.list(prefix, olderThan);
    },
  };
}
