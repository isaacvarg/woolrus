import { configDefaults, defineConfig } from "vitest/config";
import { TEST_WORKERS } from "./test/workers.ts";

/** Timing budgets (`*.bench.test.ts`, `qa/bench.test.ts`): parallel load would make them flaky. */
const BENCHMARKS = ["**/*bench.test.ts"];

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    // Every worker gets its own database, so files run in parallel (see test/global-setup.ts).
    setupFiles: ["./test/worker-db.ts"],
    maxWorkers: TEST_WORKERS,
    projects: [
      {
        extends: true,
        test: {
          name: "core",
          exclude: [...configDefaults.exclude, ...BENCHMARKS],
          // Files share the machine (and Postgres), so a test that takes 3 s alone can pass 5 s.
          testTimeout: 20_000,
          hookTimeout: 30_000,
        },
      },
      {
        extends: true,
        // Runs after `core`, one file at a time, so nothing else competes for the machine.
        test: {
          name: "bench",
          include: BENCHMARKS,
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
