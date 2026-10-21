import {
  createS3Storage,
  ensureBucketOnFirstUse,
  type ObjectStorage,
  s3ConfigFromEnv,
} from "@woolrus/core";

/** Built on first use so `next build` doesn't need storage env. The bucket is ensured then too. */
let cached: ObjectStorage | undefined;
export function storage(): ObjectStorage {
  cached ??= ensureBucketOnFirstUse(createS3Storage(s3ConfigFromEnv()));
  return cached;
}
