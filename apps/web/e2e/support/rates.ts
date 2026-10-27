import { expect, type Page } from "@playwright/test";
import { createFakeShippingProvider, runRatesFetchJob } from "@woolrus/core";
import { createDb, Prisma } from "@woolrus/db";
import { signInAs } from "./auth";

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

/** A packer packs the order's one unit into a custom box, weighs it and finishes. */
export async function packAndFinish(
  page: Page,
  order: { id: string; number: string },
  name: string,
) {
  await signInAs(page, ["PACKER"]);
  await page.goto("/queue/packing");
  await page.getByRole("searchbox", { name: "Search orders" }).fill(name);
  await page
    .getByRole("row", { name: new RegExp(order.number) })
    .getByRole("button", { name: "Start packing" })
    .click();
  await expect(page).toHaveURL(`/pack/${order.id}`, { timeout: 20_000 });
  await page.getByRole("button", { name: "Add package" }).click();
  const dialog = page.getByRole("dialog", { name: "Choose a box" });
  await dialog.getByLabel("Length").fill("5");
  await dialog.getByLabel("Width").fill("5");
  await dialog.getByLabel("Height").fill("5");
  await dialog.getByRole("button", { name: "Use this size" }).click();
  await page.getByRole("button", { name: "Put one E2E item in the selected package" }).click();
  const pkg = page.getByTestId("pack-package");
  await pkg.getByLabel("oz", { exact: true }).fill("9");
  await pkg.getByRole("button", { name: "Save weight" }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page).toHaveURL("/queue/packing", { timeout: 20_000 });
}

export function rateRows(page: Page) {
  return page
    .getByRole("table", { name: "Rates for package 1" })
    .getByRole("row")
    .filter({ has: page.getByRole("cell") });
}
