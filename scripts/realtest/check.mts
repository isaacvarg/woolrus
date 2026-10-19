// `realtest.sh check`: the Settings page's Test connection, from a shell, plus a look at how many
// orders the first import would bring in. GET requests only.
import { configuredStore } from "../../packages/core/src/index";
import { db } from "../../packages/db/src/index";

try {
  const store = await configuredStore(db, { timeoutMs: 15_000 });
  if (!store) throw new Error("no store configured: check .env.realtest");
  await store.ping();
  const units = await store.getUnits();
  const { totalPages, orders } = await store.listOrders({ status: "processing", page: 1 });
  const approx =
    totalPages > 1 ? `about ${(totalPages - 1) * 100}–${totalPages * 100}` : orders.length;
  console.log(`connected: weight in ${units.weight}, dimensions in ${units.dimension}`);
  console.log(`processing orders the first pull would import: ${approx}`);
  const oldest = orders.map((o) => o.dateCreatedGmt).sort((a, b) => a.getTime() - b.getTime())[0];
  if (oldest) console.log(`oldest on the first page: ${oldest.toISOString().slice(0, 10)}`);
} catch (error) {
  const e = error as { messageKey?: string; detail?: string; message?: string };
  console.error(`failed: ${e.messageKey ?? e.message}${e.detail ? ` (${e.detail})` : ""}`);
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
