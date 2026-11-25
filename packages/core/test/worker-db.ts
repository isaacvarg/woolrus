import { inject } from "vitest";

// Points this worker at its own copy of the test database (made by `global-setup.ts`), before the
// test file loads: `testDb()` and the tests that open raw `pg` clients read TEST_DATABASE_URL.
const urls = inject("workerDatabaseUrls");
const url = urls[Number(process.env.VITEST_POOL_ID) - 1];
if (!url) {
  throw new Error(
    `No test database for VITEST_POOL_ID=${process.env.VITEST_POOL_ID} (${urls.length} made)`,
  );
}
process.env.TEST_DATABASE_URL = url;
process.env.DATABASE_URL = url;
