import { expect, test } from "@playwright/test";
import { createDb } from "@woolrus/db";
import { signInAs } from "./support/auth";
import { createOrder, deleteCreatedOrders } from "./support/orders";
import { demoService } from "./support/qa";

// Rate Lab → Real orders (SPEC-rate-lab criterion 13, the ticket's e2e): an admin reads what a real
// package paid. One bought label is seeded straight into the quote log; other tests' labels may
// add to the figures, so this checks the sections and its own row, not totals.

const db = createDb();
let labelId: string | undefined;
let fetchId: string | undefined;

test.afterAll(async () => {
  if (labelId) await db.shippingLabel.delete({ where: { id: labelId } });
  if (fetchId) await db.rateFetch.delete({ where: { id: fetchId } });
  await deleteCreatedOrders();
});

test("an admin opens Real orders and sees the tiles, charts and alternatives", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop", "Rate Lab users are on desktops (assumption 5)");
  const { carrier, service } = await demoService();
  const order = await createOrder({ status: "COMPLETED", quantity: 1 });
  await db.order.update({ where: { id: order.id }, data: { shippingChargedCents: 500 } });
  const pkg = await db.package.create({
    data: { orderId: order.id, number: 1, weightOz: 16, lengthIn: 8, widthIn: 6, heightIn: 4 },
  });
  const quote = {
    provider: "SHIPSTATION" as const,
    carrierId: carrier.id,
    serviceId: service.id,
    carrierCode: "demo_ground",
    serviceCode: "demo_ground",
    serviceName: "Demo Ground",
    currency: "USD",
    guaranteed: false,
    quoteOnly: false,
    fake: false,
  };
  const fetch = await db.rateFetch.create({
    data: {
      source: "ORDER",
      trigger: "PACKING_COMPLETE",
      orderId: order.id,
      packageId: pkg.id,
      destCountry: "US",
      destState: "TX",
      residential: true,
      international: false,
      lengthIn: 8,
      widthIn: 6,
      heightIn: 4,
      weightOz: 16,
      fake: false,
      quotes: {
        create: [
          { ...quote, amountCents: 450, deliveryDays: 5, cheapest: true },
          { ...quote, amountCents: 725, deliveryDays: 2, cheapest: false },
        ],
      },
    },
    include: { quotes: { orderBy: { amountCents: "asc" } } },
  });
  fetchId = fetch.id;
  const bought = fetch.quotes[1];
  if (!bought) throw new Error("missing quote");
  const label = await db.shippingLabel.create({
    data: {
      packageId: pkg.id,
      status: "ACTIVE",
      provider: "SHIPSTATION",
      idempotencyKey: `e2e-real-orders-${crypto.randomUUID()}`,
      carrierCode: "demo_ground",
      serviceCode: "demo_ground",
      carrierId: carrier.id,
      serviceId: service.id,
      costCents: 725,
      quotedAmountCents: 725,
      currency: "USD",
      purchasedAt: new Date(Date.now() - 60 * 60 * 1000),
      rateQuoteId: bought.id,
      selectionReason: "FASTER_DELIVERY",
    },
  });
  labelId = label.id;

  await signInAs(page, ["ADMIN"]);
  await page.goto("/rate-lab/runs");
  await page
    .getByRole("navigation", { name: "Rate Lab sections" })
    .getByRole("link", { name: "Real orders" })
    .click();
  await expect(page).toHaveURL("/rate-lab/real-orders");

  const summary = page.getByRole("region", { name: "Summary" });
  for (const tile of ["Packages", "On the cheapest", "Not the cheapest", "Overspend"]) {
    await expect(summary.getByText(tile, { exact: true })).toBeVisible();
  }
  for (const chart of [
    "Overspend by reason",
    "Spend by carrier",
    "Median label cost per lane, by week",
  ]) {
    const figure = page.getByRole("figure", { name: chart });
    await expect(figure).toBeVisible();
    await expect(figure.locator("svg.recharts-surface").first()).toBeVisible();
  }
  // Each chart's table is there for screen readers, and opens for everyone.
  const reasons = page.getByRole("figure", { name: "Overspend by reason" });
  await reasons.getByRole("button", { name: "Show the data" }).click();
  await expect(reasons.getByRole("cell", { name: "Faster delivery" })).toBeVisible();

  const alternatives = page.getByRole("table", { name: "Alternatives" });
  const row = alternatives.getByRole("row").filter({ hasText: `#${order.number} · package 1` });
  await expect(row).toContainText("Demo Ground: $4.50");
  await expect(row).toContainText("Demo Ground: $7.25");
  await expect(row).toContainText("Faster delivery");
});
