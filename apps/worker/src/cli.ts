import { configuredStore, pollIfDue } from "@woolrus/core";
import { db } from "@woolrus/db";

// `pnpm sync:pull` (FR-SYNC-08): the same poll as the worker and "Sync now", run from a shell.
// It takes the same lock, so it reports "already running" rather than overlapping a worker poll.

const usage = "usage: cli pull";
const [command] = process.argv.slice(2);
if (command !== "pull") {
  console.error(usage);
  process.exit(2);
}

try {
  const result = await pollIfDue(db, await configuredStore(db), { reason: "manual" });
  if (result.status === "alreadyRunning" || result.status === "notDue") {
    console.log(`orders: ${result.status}`);
  } else {
    const { status, imported, updated, skipped, failed, runId } = result;
    console.log(
      `orders: ${status} (imported ${imported}, updated ${updated}, unchanged ${skipped}, failed ${failed})`,
    );
    const run = await db.syncRun.findUniqueOrThrow({
      where: { id: runId },
      include: { errors: { orderBy: { createdAt: "asc" } } },
    });
    if (run.error) console.log(`  run error: ${run.error}`);
    for (const error of run.errors) console.log(`  order ${error.externalId}: ${error.error}`);
    process.exitCode = status === "FAILED" ? 1 : 0;
  }
} finally {
  await db.$disconnect();
}
