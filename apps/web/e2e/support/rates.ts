import { createFakeShippingProvider, runRatesFetchJob } from "@woolrus/core";
import { createDb, Prisma } from "@woolrus/db";

const db = createDb();

// The fakes, whatever SHIPPING_PROVIDERS says in this process: a test must never reach a real
// provider.
const adapters = {
  SHIPSTATION: (credentials: Record<string, string>) =>
    createFakeShippingProvider("SHIPSTATION", { credentials }),
  BRIDGE_SOURCE: (credentials: Record<string, string>) =>
    createFakeShippingProvider("BRIDGE_SOURCE", { credentials }),
};

/**
 * Runs the order's current `rates.fetch` as the worker would. CI starts no worker, so the job
 * Packing → QA or Refresh rates enqueued would otherwise never run.
 */
export async function runRateFetch(orderId: string) {
  const { rateGeneration } = await db.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { rateGeneration: true },
  });
  return runRatesFetchJob(db, { orderId, generation: rateGeneration }, { adapters });
}

const shipFrom = {
  name: "E2E Warehouse",
  phone: "512-555-0000",
  address1: "100 Dock Rd",
  city: "Austin",
  state: "TX",
  postalCode: "78702",
  country: "US",
};

/** Rates need a ship-from address; a fresh database (CI) has none. Leaves one that's set alone. */
export async function ensureShipFrom() {
  await db.$executeRaw`INSERT INTO settings (id, updated_at) VALUES (1, now()) ON CONFLICT (id) DO NOTHING`;
  await db.settings.updateMany({
    where: { shipFromAddress: { equals: Prisma.DbNull } },
    data: { shipFromAddress: shipFrom },
  });
}
