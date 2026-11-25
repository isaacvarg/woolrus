import os from "node:os";

/**
 * How many test files run at once. Each worker gets its own copy of the test database (see
 * `global-setup.ts`). Postgres runs on the same machine, so leave it a core.
 */
export const TEST_WORKERS = Math.max(1, os.availableParallelism() - 1);
