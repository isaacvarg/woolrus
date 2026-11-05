import { expect, test } from "@playwright/test";
import { createDb } from "@woolrus/db";
import { signInAs } from "./support/auth";
import { createOrder, deleteCreatedOrders } from "./support/orders";
import { demoService } from "./support/qa";

// Rate Lab → Real orders (SPEC-rate-lab criterion 13, the ticket's e2e): an admin reads what a real
// package paid. One bought label is seeded straight into the quote log; other tests' labels may
// add to the figures, so this checks the sections and its own row, not totals.

const db = createDb();
const prefix = `E2E real ${crypto.randomUUID().slice(0, 8)}`;
const labelIds: string[] = [];
const fetchIds: string[] = [];
const carrierIds: string[] = [];

test.afterAll(async () => {
  await db.shippingLabel.deleteMany({ where: { id: { in: labelIds } } });
  await db.rateFetch.deleteMany({ where: { id: { in: fetchIds } } });
  await db.carrierService.deleteMany({ where: { carrierId: { in: carrierIds } } });
  await db.shippingCarrier.deleteMany({ where: { id: { in: carrierIds } } });
  await deleteCreatedOrders();
});

/** A carrier of the test's own with one service, off so nothing else quotes it. */
async function ownCarrier(name: string) {
  const carrier = await db.shippingCarrier.create({
    data: {
      provider: "SHIPSTATION",
      externalId: `${prefix} ${name}`,
      code: name.toLowerCase(),
      name: `${prefix} ${name}`,
      enabled: false,
      services: {
        create: {
          code: `${name.toLowerCase()}_ground`,
          name: `${prefix} ${name} Ground`,
          domestic: true,
          international: false,
          enabled: false,
        },
      },
    },
    include: { services: true },
  });
  carrierIds.push(carrier.id);
  const [service] = carrier.services;
  if (!service) throw new Error("service missing");
  return { carrier, service };
}

/** One bought package to `state`: its fetch with a single quote, and the label bought from it. */
async function boughtPackage(
  { carrier, service }: Awaited<ReturnType<typeof ownCarrier>>,
  state: string,
  cents: number,
) {
  const order = await createOrder({ status: "COMPLETED", quantity: 1 });
  const pkg = await db.package.create({
    data: { orderId: order.id, number: 1, weightOz: 16, lengthIn: 8, widthIn: 6, heightIn: 4 },
  });
  const fetch = await db.rateFetch.create({
    data: {
      source: "ORDER",
      trigger: "PACKING_COMPLETE",
      orderId: order.id,
      packageId: pkg.id,
      destCountry: "US",
      destState: state,
      residential: true,
      international: false,
      lengthIn: 8,
      widthIn: 6,
      heightIn: 4,
      weightOz: 16,
      fake: false,
      quotes: {
        create: {
          provider: "SHIPSTATION",
          carrierId: carrier.id,
          serviceId: service.id,
          carrierCode: carrier.code,
          serviceCode: service.code,
          serviceName: service.name,
          currency: "USD",
          guaranteed: false,
          quoteOnly: false,
          fake: false,
          amountCents: cents,
          deliveryDays: 3,
          cheapest: true,
        },
      },
    },
    include: { quotes: true },
  });
  fetchIds.push(fetch.id);
  const [quote] = fetch.quotes;
  if (!quote) throw new Error("missing quote");
  const label = await db.shippingLabel.create({
    data: {
      packageId: pkg.id,
      status: "ACTIVE",
      provider: "SHIPSTATION",
      idempotencyKey: `e2e-real-orders-${crypto.randomUUID()}`,
      carrierCode: carrier.code,
      serviceCode: service.code,
      carrierId: carrier.id,
      serviceId: service.id,
      costCents: cents,
      quotedAmountCents: cents,
      currency: "USD",
      purchasedAt: new Date(Date.now() - 60 * 60 * 1000),
      rateQuoteId: quote.id,
    },
  });
  labelIds.push(label.id);
  return order;
}

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
  fetchIds.push(fetch.id);
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
  labelIds.push(label.id);

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

test("Real orders filters by carrier, service and lane; a new carrier or country starts its child over", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop", "Rate Lab users are on desktops (assumption 5)");
  const alpha = await ownCarrier("Alpha");
  const beta = await ownCarrier("Beta");
  const toTexas = await boughtPackage(alpha, "TX", 610);
  const toWashington = await boughtPackage(beta, "WA", 820);
  const packageOf = (order: { number: string | number }) => `#${order.number} · package 1`;

  await signInAs(page, ["ADMIN"]);
  await page.goto("/rate-lab/real-orders");
  const alternatives = page.getByRole("table", { name: "Alternatives" });
  const csv = page.getByRole("link", { name: "Export CSV" });
  const choose = async (filter: RegExp, option: string) => {
    await page.getByRole("button", { name: filter }).click();
    await page.getByRole("option", { name: option, exact: true }).click();
  };
  await expect(alternatives).toContainText(packageOf(toTexas));
  await expect(alternatives).toContainText(packageOf(toWashington));

  // Carrier, then one of its services: only that package, and the CSV carries both.
  await choose(/Carrier/, alpha.carrier.name);
  await choose(/Service/, alpha.service.name);
  await expect(alternatives).toContainText(packageOf(toTexas));
  await expect(alternatives).not.toContainText(packageOf(toWashington));
  await expect(csv).toHaveAttribute("href", new RegExp(`serviceId=${alpha.service.id}`));

  // Another carrier: the old service would match nothing, so it goes back to All.
  await choose(/Carrier/, beta.carrier.name);
  await expect(page.getByRole("button", { name: /Service/ })).toContainText("All");
  await expect(alternatives).toContainText(packageOf(toWashington));
  await expect(alternatives).not.toContainText(packageOf(toTexas));
  await expect(csv).not.toHaveAttribute("href", /serviceId=/);
  await expect(csv).toHaveAttribute("href", new RegExp(`carrierId=${beta.carrier.id}`));

  // A lane: country, then state; a new country clears the state.
  await choose(/Carrier/, "All");
  await choose(/Country/, "US");
  await choose(/State/, "US-TX");
  await expect(alternatives).toContainText(packageOf(toTexas));
  await expect(alternatives).not.toContainText(packageOf(toWashington));
  await choose(/Country/, "All");
  await expect(page.getByRole("button", { name: /State/ })).toContainText("All");
  await expect(alternatives).toContainText(packageOf(toWashington));
  await expect(csv).not.toHaveAttribute("href", /state=/);

  // Fake data travels as 1, like the PDF report's link.
  await page.getByText("Include fake data").click();
  await expect(csv).toHaveAttribute("href", /includeFake=1/);
});
