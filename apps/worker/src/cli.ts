import { configuredStore, pollIfDue, syncProducts } from "@woolrus/core";
import { db } from "@woolrus/db";

// `pnpm sync:pull` / `pnpm sync:products` (FR-SYNC-08): the same runs as the worker and the Sync
// page, from a shell. They take the same locks, so they report "already running" rather than
// overlapping a worker run.

const usage = "usage: cli pull|products";
const [command] = process.argv.slice(2);
if (command !== "pull" && command !== "products") {
  console.error(usage);
  process.exit(2);
}

try {
  if (command === "pull") {
    const result = await pollIfDue(db, await configuredStore(db), { reason: "manual" });
    if (result.status === "alreadyRunning" || result.status === "notDue") {
      console.log(`orders: ${result.status}`);
    } else {
      const { status, imported, updated, skipped, failed, runId } = result;
      console.log(
        `orders: ${status} (imported ${imported}, updated ${updated}, unchanged ${skipped}, failed ${failed})`,
      );
      await printRun(runId, "order");
      process.exitCode = status === "FAILED" ? 1 : 0;
    }
  } else {
    const result = await syncProducts(db, await configuredStore(db));
    if (result.status === "alreadyRunning") {
      console.log("products: alreadyRunning");
    } else {
      const { status, processed, failed, runId } = result;
      console.log(`products: ${status} (written ${processed}, failed ${failed})`);
      await printRun(runId, "product");
      process.exitCode = status === "FAILED" ? 1 : 0;
    }
  }
} finally {
  await db.$disconnect();
}

/** The run's whole-run error and per-record errors, one per line. */
async function printRun(runId: string, record: string): Promise<void> {
  const run = await db.syncRun.findUniqueOrThrow({
    where: { id: runId },
    include: { errors: { orderBy: { createdAt: "asc" } } },
  });
  if (run.error) console.log(`  run error: ${run.error}`);
  for (const error of run.errors) console.log(`  ${record} ${error.externalId}: ${error.error}`);
}
