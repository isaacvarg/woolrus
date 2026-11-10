import { expect, type Page, test } from "@playwright/test";
import { createDb } from "@woolrus/db";
import { signInAs } from "./support/auth";
import { createOrder, deleteCreatedOrders } from "./support/orders";
import { demoService } from "./support/qa";
import { ensureShipFrom } from "./support/rates";
import { withSettingsLock } from "./support/settings-lock";

// Lot capture at Packing (SPEC-lumexia criteria 5–8, ticket #163). The product is set to always
// need a lot with its own override, so no global lot rule changes under tests running in parallel.

const db = createDb();
test.afterAll(() => deleteCreatedOrders());

async function scanCode(page: Page, code: string) {
  await page.keyboard.type(code, { delay: 5 });
  await page.keyboard.press("Enter");
}

test("a packer scans lots into a box: Lot needed, chips, a wrong-item refusal, and the gate over /api/v1", async ({
  page,
}) => {
  const customerName = `E2E ${crypto.randomUUID()}`;
  const order = await createOrder({
    customerName,
    quantity: 3,
    status: "PACKING",
    ownProduct: true,
  });
  const line = await db.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
  const product = await db.product.findUniqueOrThrow({ where: { id: line.productId as string } });
  // Its own SKU ("E2E-<id>") stands in for the Lumexia reference code the lot numbers carry.
  const ref = (product.sku as string).toUpperCase();
  await db.product.update({
    where: { id: product.id },
    data: { lumexiaItemId: crypto.randomUUID(), lumexiaItemRef: ref, lotOverride: true },
  });

  await signInAs(page, ["PACKER"]);
  await page.goto("/queue/packing");
  await page.getByRole("searchbox", { name: "Search orders" }).fill(customerName);
  await page
    .getByRole("row", { name: new RegExp(order.number) })
    .getByRole("button", { name: "Start packing" })
    .click();
  await expect(page).toHaveURL(`/pack/${order.id}`, { timeout: 20_000 });

  await page.getByRole("button", { name: "Add package" }).click();
  const dialog = page.getByRole("dialog", { name: "Choose a box" });
  await dialog.getByLabel("Length").fill("12");
  await dialog.getByLabel("Width").fill("9");
  await dialog.getByLabel("Height").fill("4");
  await dialog.getByRole("button", { name: "Use this size" }).click();
  await expect(dialog).toBeHidden();

  const banner = page.getByTestId("scan-banner");
  // A product scan still packs the product.
  for (let i = 0; i < 3; i++) await scanCode(page, "E2E-SKU");
  await expect(page.getByTestId("pack-package").first()).toContainText("×3");
  await expect(page.getByTestId("pack-lot-needed")).toHaveText("Lot needed");

  // The gate holds through the REST API too.
  const version = async () =>
    (await db.order.findUniqueOrThrow({ where: { id: order.id } })).version;
  const refused = await page.request.post(`/api/v1/orders/${order.id}/complete-pack`, {
    data: { expectedVersion: await version(), after: "queue" },
  });
  expect(refused.status()).toBe(409);
  const unmet = (await refused.json()).data.unmet.map((u: { messageKey: string }) => u.messageKey);
  expect(unmet).toContain("errors.workflow.gate.lotMissing");

  // A lot for another item is refused in the banner and saves nothing.
  await scanCode(page, "BASE9999.A12A0124");
  await expect(banner).toHaveAttribute("data-ok", "false");
  await expect(banner).toContainText("Lot BASE9999.A12A0124 belongs to another item");
  await expect(page.getByTestId("pack-lot-needed")).toBeVisible();

  // Lot scans go to the lot: the first covers all 3 units, the next takes 1.
  await scanCode(page, `${ref.toLowerCase()}.a12a0124`);
  await expect(banner).toHaveAttribute("data-ok", "true");
  const lots = page.getByTestId("pack-lots");
  await expect(lots).toContainText("3 × A12A0124");
  await scanCode(page, `${ref}.B07C1124`);
  await expect(lots).toContainText("2 × A12A0124");
  await expect(lots).toContainText("1 × B07C1124");
  await expect(page.getByTestId("pack-lot-needed")).toHaveCount(0);

  const after = await page.request.post(`/api/v1/orders/${order.id}/complete-pack`, {
    data: { expectedVersion: await version(), after: "queue" },
  });
  // Still refused for the missing weight, but no longer for the lot.
  const left = (await after.json()).data.unmet.map((u: { messageKey: string }) => u.messageKey);
  expect(left).not.toContain("errors.workflow.gate.lotMissing");

  // What's shown is what the server kept.
  await page.reload();
  await expect(page.getByTestId("pack-lots")).toContainText("1 × B07C1124");
});

test("a packer picks the line in Which line? and edits a lot's count from its chip (ticket #164)", async ({
  page,
}) => {
  const customerName = `E2E ${crypto.randomUUID()}`;
  const order = await createOrder({
    customerName,
    quantity: 3,
    status: "PACKING",
    ownProduct: true,
  });
  const line = await db.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
  const product = await db.product.findUniqueOrThrow({ where: { id: line.productId as string } });
  const ref = (product.sku as string).toUpperCase();
  await db.product.update({
    where: { id: product.id },
    data: { lumexiaItemId: crypto.randomUUID(), lumexiaItemRef: ref, lotOverride: true },
  });
  // A second variation of the same item: both lines take its lots.
  await db.orderItem.create({
    data: {
      orderId: order.id,
      wooLineItemId: order.wooOrderId + 900_000,
      productId: product.id,
      sku: "E2E-SKU-L",
      name: "E2E item (Large)",
      quantity: 2,
      unitPriceCents: 500,
      attributes: [],
    },
  });

  await signInAs(page, ["PACKER"]);
  await page.goto("/queue/packing");
  await page.getByRole("searchbox", { name: "Search orders" }).fill(customerName);
  await page
    .getByRole("row", { name: new RegExp(order.number) })
    .getByRole("button", { name: "Start packing" })
    .click();
  await expect(page).toHaveURL(`/pack/${order.id}`, { timeout: 20_000 });

  await page.getByRole("button", { name: "Add package" }).click();
  const boxDialog = page.getByRole("dialog", { name: "Choose a box" });
  await boxDialog.getByLabel("Length").fill("12");
  await boxDialog.getByLabel("Width").fill("9");
  await boxDialog.getByLabel("Height").fill("4");
  await boxDialog.getByRole("button", { name: "Use this size" }).click();
  await expect(boxDialog).toBeHidden();
  await page.getByRole("button", { name: "Put everything left here" }).click();
  await expect(page.getByTestId("pack-lot-needed")).toHaveCount(2);

  // The lot fits both lines: Which line? asks, and the scan goes on the one chosen.
  await scanCode(page, `${ref}.A12A0124`);
  const which = page.getByRole("dialog", { name: "Which line?" });
  await which.getByRole("button", { name: /E2E item \(Large\)/ }).click();
  await expect(which).toBeHidden();
  const lots = page.getByTestId("pack-lots");
  await expect(lots).toContainText("2 × A12A0124");
  await expect(page.getByTestId("pack-lot-needed")).toHaveCount(1);

  // A second lot on the 3-unit line, then its count changed from the chip.
  await scanCode(page, `${ref}.A12A0124`);
  await which.getByRole("button", { name: /E2E item \(3/ }).click();
  await scanCode(page, `${ref}.B07C1124`);
  await which.getByRole("button", { name: /E2E item \(3/ }).click();
  await expect(lots).toContainText("1 × B07C1124");
  await lots.getByRole("button", { name: "1 from lot B07C1124" }).click();
  const lotDialog = page.getByRole("dialog", { name: "Lot B07C1124" });
  await lotDialog.getByLabel("Units from this lot").fill("2");
  await lotDialog.getByRole("button", { name: "Save count" }).click();
  await expect(lotDialog).toBeHidden();
  await expect(lots).toContainText("2 × B07C1124");
  await expect(lots).toContainText("1 × A12A0124");

  await page.reload();
  await expect(page.getByTestId("pack-lots")).toContainText("2 × B07C1124");
});

test("pack two lots into a box, then a wrong-item lot blocks Complete QA until QA replaces it (criterion 13)", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const customerName = `E2E ${crypto.randomUUID()}`;
  const order = await createOrder({
    customerName,
    quantity: 3,
    status: "PACKING",
    ownProduct: true,
  });
  const line = await db.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
  const product = await db.product.findUniqueOrThrow({ where: { id: line.productId as string } });
  const ref = (product.sku as string).toUpperCase();
  await db.product.update({
    where: { id: product.id },
    data: { lumexiaItemId: crypto.randomUUID(), lumexiaItemRef: ref, lotOverride: true },
  });

  // Packing: 3 units, lot A then lot B, weighed, done.
  await signInAs(page, ["PACKER"]);
  await page.goto("/queue/packing");
  await page.getByRole("searchbox", { name: "Search orders" }).fill(customerName);
  await page
    .getByRole("row", { name: new RegExp(order.number) })
    .getByRole("button", { name: "Start packing" })
    .click();
  await expect(page).toHaveURL(`/pack/${order.id}`, { timeout: 20_000 });
  await page.getByRole("button", { name: "Add package" }).click();
  const boxDialog = page.getByRole("dialog", { name: "Choose a box" });
  await boxDialog.getByLabel("Length").fill("12");
  await boxDialog.getByLabel("Width").fill("9");
  await boxDialog.getByLabel("Height").fill("4");
  await boxDialog.getByRole("button", { name: "Use this size" }).click();
  await expect(boxDialog).toBeHidden();
  for (let i = 0; i < 3; i++) await scanCode(page, "E2E-SKU");
  await expect(page.getByTestId("pack-package").first()).toContainText("×3");
  await scanCode(page, `${ref}.A12A0124`);
  await scanCode(page, `${ref}.B07C1124`);
  const lots = page.getByTestId("pack-lots");
  await expect(lots).toContainText("2 × A12A0124");
  await expect(lots).toContainText("1 × B07C1124");
  const pkg = page.getByTestId("pack-package");
  await pkg.getByLabel("oz", { exact: true }).fill("40");
  await pkg.getByRole("button", { name: "Save weight" }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page).toHaveURL("/queue/packing", { timeout: 20_000 });
  expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("QA");

  // Lumexia's check (the worker's job; CI starts none) finds lot B is another item's.
  const lotB = await db.packageItemLot.findFirstOrThrow({
    where: { lotNumber: `${ref}.B07C1124`, packageItem: { package: { orderId: order.id } } },
  });
  await db.packageItemLot.update({ where: { id: lotB.id }, data: { status: "WRONG_ITEM" } });

  await withSettingsLock(async () => {
    // A selected demo rate (the rate fetch is a worker job too) and ShipStation on.
    await ensureShipFrom();
    const before = await db.shippingProviderAccount.findUnique({
      where: { provider: "SHIPSTATION" },
    });
    await db.shippingProviderAccount.upsert({
      where: { provider: "SHIPSTATION" },
      create: { provider: "SHIPSTATION", enabled: true },
      update: { enabled: true },
    });
    const { carrier, service, created } = await demoService();
    const box = await db.package.findFirstOrThrow({ where: { orderId: order.id } });
    await db.shippingRate.create({
      data: {
        packageId: box.id,
        provider: "SHIPSTATION",
        carrierId: carrier.id,
        serviceId: service.id,
        carrierCode: "demo_ground",
        serviceCode: "demo_ground",
        serviceName: "Demo Ground",
        providerRateId: "se-rate:se-demo-ground:demo_ground:450",
        amountCents: 450,
        currency: "USD",
        selected: true,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    try {
      const qa = await signInAs(page, ["QA"]);
      await db.order.update({
        where: { id: order.id },
        data: { claimedById: qa.id, claimedAt: new Date() },
      });
      await page.goto(`/qa/${order.id}`);
      await page.getByTestId("qa-row").click();
      await expect(page.getByTestId("qa-row")).toHaveAttribute("data-verified", "true");

      // Lot A is only unverified, a warning; lot B blocks.
      await expect(page.getByTestId("qa-lot").filter({ hasText: "A12A0124" })).toContainText(
        "Unverified",
      );
      const wrong = page.getByTestId("qa-lot").filter({ hasText: "B07C1124" });
      await expect(wrong).toContainText("Wrong item");
      await expect(wrong.getByTestId("qa-lot-blocking")).toHaveText("Blocks the label");
      await expect(page.getByTestId("qa-unmet")).toContainText(
        `has lot ${ref}.B07C1124, which belongs to a different item`,
      );
      await expect(page.getByTestId("qa-complete")).toHaveCount(0);

      // The REST API refuses it too.
      const version = (await db.order.findUniqueOrThrow({ where: { id: order.id } })).version;
      const refused = await page.request.post(`/api/v1/orders/${order.id}/complete-qa`, {
        data: { expectedVersion: version },
      });
      expect(refused.status()).toBe(409);
      const unmet = (await refused.json()).data.unmet.map(
        (u: { messageKey: string }) => u.messageKey,
      );
      expect(unmet).toEqual(["errors.workflow.gate.lotWrongItem"]);

      // Replace lot: yet another item's lot is refused, the right one clears the block.
      await wrong.getByRole("button", { name: "Replace lot" }).click();
      const dialog = page.getByRole("dialog", { name: "Replace lot B07C1124" });
      const field = dialog.getByLabel("New lot");
      await field.fill("BASE9999.A12A0124");
      await field.press("Enter");
      await expect(dialog.getByTestId("qa-replace-lot-error")).toContainText(
        "Lot BASE9999.A12A0124 belongs to another item",
      );
      await field.fill(`${ref}.C01D0125`);
      await field.press("Enter");
      await expect(dialog).toBeHidden();
      await expect(page.getByTestId("qa-lot").filter({ hasText: "C01D0125" })).toContainText(
        "1 × C01D0125",
      );
      await expect(page.getByTestId("qa-lot-blocking")).toHaveCount(0);
      await expect(page.getByTestId("qa-complete")).toBeVisible();

      await page.reload();
      await expect(page.getByTestId("qa-lot")).toHaveCount(2);
      await expect(page.getByTestId("qa-complete")).toBeVisible();
    } finally {
      await db.shippingRate.deleteMany({ where: { package: { orderId: order.id } } });
      await db.order.update({ where: { id: order.id }, data: { claimedById: null } });
      if (created) {
        await db.carrierService.deleteMany({ where: { carrierId: carrier.id } });
        await db.shippingCarrier.deleteMany({ where: { id: carrier.id } });
      }
      await db.shippingProviderAccount.update({
        where: { provider: "SHIPSTATION" },
        data: { enabled: before?.enabled ?? false },
      });
    }
  });
});
