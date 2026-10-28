import { expect, test } from "@playwright/test";
import { createDb } from "@woolrus/db";
import { signInAs } from "./support/auth";
import { createOrder, deleteCreatedOrders } from "./support/orders";
import { withSettingsLock } from "./support/settings-lock";

const db = createDb();

test.afterAll(deleteCreatedOrders);

/** A QA order with one package holding all of the line's units. */
async function qaOrder(customerName: string, quantity = 3) {
  const order = await createOrder({ customerName, status: "QA", quantity });
  const line = await db.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
  const pkg = await db.package.create({ data: { orderId: order.id, number: 1, weightOz: 16 } });
  await db.packageItem.create({
    data: { packageId: pkg.id, orderItemId: line.id, quantity },
  });
  return order;
}

test("Start QA claims the order; tapping a row verifies it in full and tapping again clears it", async ({
  page,
}) => {
  const customerName = `E2E ${crypto.randomUUID()}`;
  const order = await qaOrder(customerName);
  await signInAs(page, ["QA"]);
  await page.goto("/queue/qa");
  await page.getByRole("searchbox", { name: "Search orders" }).fill(customerName);
  await page
    .getByRole("row", { name: new RegExp(order.number) })
    .getByRole("button", { name: "Start QA" })
    .click();
  await expect(page).toHaveURL(`/qa/${order.id}`, { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: `QA #${order.number}` })).toBeVisible();

  const row = page.getByTestId("qa-row");
  await expect(page.getByTestId("qa-package-count")).toHaveText("0 of 1 verified");
  await expect(page.getByTestId("qa-unmet")).toBeVisible();

  await row.click();
  await expect(row).toHaveAttribute("data-verified", "true");
  await expect(page.getByTestId("qa-row-progress")).toHaveText("3 of 3");
  await expect(page.getByTestId("qa-package-count")).toHaveText("1 of 1 verified");
  await expect
    .poll(() =>
      db.packageItem
        .findFirstOrThrow({ where: { package: { orderId: order.id } } })
        .then((r) => r.qaVerifiedQuantity),
    )
    .toBe(3);

  await row.click();
  await expect(row).toHaveAttribute("data-verified", "false");
  await expect(page.getByTestId("qa-package-count")).toHaveText("0 of 1 verified");
  await expect
    .poll(() =>
      db.packageItem
        .findFirstOrThrow({ where: { package: { orderId: order.id } } })
        .then((r) => r.qaVerifiedQuantity),
    )
    .toBe(0);
});

test("the order drawer shows picker, packer, rate and notes", async ({ page }) => {
  const order = await qaOrder(`E2E ${crypto.randomUUID()}`, 2);
  const qa = await signInAs(page, ["QA"]);
  await db.order.update({
    where: { id: order.id },
    data: { claimedById: qa.id, claimedAt: new Date() },
  });
  await page.goto(`/qa/${order.id}`);
  await page.getByRole("button", { name: "Order details" }).click();
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByTestId("qa-drawer-rate")).toHaveText("No rate selected");
  await expect(drawer.getByTestId("qa-drawer-row")).toContainText("Picked by Nobody recorded");
  await expect(drawer.getByTestId("qa-drawer-row")).toContainText("QA: 0 of 2 verified");
});

test("a Packer can read the screen but not tap", async ({ page }) => {
  const order = await qaOrder(`E2E ${crypto.randomUUID()}`, 1);
  await signInAs(page, ["PACKER"]);
  await page.goto(`/qa/${order.id}`);
  await expect(page.getByTestId("qa-row")).toBeDisabled();
  await expect(page.getByTestId("qa-banner")).toContainText("not claimed by you");
});

test("Complete QA records the intent and shows the labels being bought, with Next order", async ({
  page,
}) => {
  const order = await qaOrder(`E2E ${crypto.randomUUID()}`, 2);
  const qa = await signInAs(page, ["QA"]);
  const pkg = await db.package.findFirstOrThrow({ where: { orderId: order.id } });
  await db.packageItem.updateMany({
    where: { packageId: pkg.id },
    data: { qaVerifiedQuantity: 2, qaVerifiedAt: new Date(), qaVerifiedById: qa.id },
  });
  await db.order.update({
    where: { id: order.id },
    data: { claimedById: qa.id, claimedAt: new Date() },
  });

  await withSettingsLock(async () => {
    const before = await db.shippingProviderAccount.findUnique({
      where: { provider: "SHIPSTATION" },
    });
    await db.shippingProviderAccount.upsert({
      where: { provider: "SHIPSTATION" },
      create: { provider: "SHIPSTATION", enabled: true },
      update: { enabled: true },
    });
    const carrier = await db.shippingCarrier.create({
      data: {
        provider: "SHIPSTATION",
        externalId: `e2e-${crypto.randomUUID()}`,
        code: "usps",
        name: "E2E carrier",
        enabled: true,
      },
    });
    const service = await db.carrierService.create({
      data: {
        carrierId: carrier.id,
        code: "e2e_ground",
        name: "E2E Ground",
        domestic: true,
        international: false,
        enabled: true,
      },
    });
    await db.shippingRate.create({
      data: {
        packageId: pkg.id,
        provider: "SHIPSTATION",
        carrierId: carrier.id,
        serviceId: service.id,
        carrierCode: "usps",
        serviceCode: "e2e_ground",
        serviceName: "E2E Ground",
        amountCents: 650,
        currency: "USD",
        selected: true,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    try {
      await page.goto(`/qa/${order.id}`);
      await expect(page.getByTestId("qa-all-done")).toBeVisible();
      await page.getByTestId("qa-complete").click();
      await expect(page.getByTestId("qa-buying")).toHaveText("Buying labels… 0 of 1");
      await expect(page.getByTestId("qa-next-order")).toBeVisible();
      await expect(page.getByTestId("qa-complete")).toHaveCount(0);
      await expect
        .poll(() => db.shippingLabel.count({ where: { packageId: pkg.id, status: "PURCHASING" } }))
        .toBe(1);
    } finally {
      await db.shippingLabel.deleteMany({ where: { packageId: pkg.id } });
      await db.shippingRate.deleteMany({ where: { packageId: pkg.id } });
      await db.carrierService.deleteMany({ where: { carrierId: carrier.id } });
      await db.shippingCarrier.delete({ where: { id: carrier.id } });
      await db.shippingProviderAccount.update({
        where: { provider: "SHIPSTATION" },
        data: { enabled: before?.enabled ?? false },
      });
    }
  });
});

test("a Shipper doesn't get a Complete QA button", async ({ page }) => {
  const order = await qaOrder(`E2E ${crypto.randomUUID()}`, 1);
  await signInAs(page, ["SHIPPER"]);
  await page.goto(`/qa/${order.id}`);
  await expect(page.getByTestId("qa-complete")).toHaveCount(0);
});
