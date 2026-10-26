import { expect, type Page, test } from "@playwright/test";
import { createDb } from "@woolrus/db";
import { signInAs } from "./support/auth";
import { createOrder, deleteCreatedOrders, type ProductSize } from "./support/orders";

const db = createDb();
const boxIds: string[] = [];

test.afterAll(async () => {
  await deleteCreatedOrders();
  await db.box.deleteMany({ where: { id: { in: boxIds.splice(0) } } });
});

/** Opens a fresh Packing order from its queue row, as a packer would. */
async function startPacking(page: Page, quantity: number, productSize?: ProductSize) {
  const customerName = `E2E ${crypto.randomUUID()}`;
  const order = await createOrder({
    customerName,
    quantity,
    status: "PACKING",
    rushOrderLine: true,
    productSize,
  });
  await signInAs(page, ["PACKER"]);
  await page.goto("/queue/packing");
  await page.getByRole("searchbox", { name: "Search orders" }).fill(customerName);
  await page
    .getByRole("row", { name: new RegExp(order.number) })
    .getByRole("button", { name: "Start packing" })
    .click();
  // The first load of the pack screen compiles it in dev, and parallel workers share the server.
  await expect(page).toHaveURL(`/pack/${order.id}`, { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: `Pack #${order.number}` })).toBeVisible();
  return order;
}

/** Adds a package of a custom size, which needs no box set up in the dev stack. */
async function addCustomPackage(page: Page) {
  await page.getByRole("button", { name: "Add package" }).click();
  const dialog = page.getByRole("dialog", { name: "Choose a box" });
  await dialog.getByLabel("Length").fill("12");
  await dialog.getByLabel("Width").fill("9");
  await dialog.getByLabel("Height").fill("4");
  await dialog.getByRole("button", { name: "Use this size" }).click();
  await expect(dialog).toBeHidden();
}

test("Start packing opens the pack screen; add packages, split a line, unpack, delete", async ({
  page,
}) => {
  const order = await startPacking(page, 6);
  const item = page.getByTestId("pack-item");
  // The Rush Order line isn't packed by anyone, so it isn't shown.
  await expect(item).toHaveCount(1);
  await expect(item.getByTestId("pack-left")).toHaveText("6 left");
  await expect(page.getByText("Add a package or pick one first")).toBeVisible();

  await addCustomPackage(page);
  const packages = page.getByTestId("pack-package");
  await expect(packages).toHaveCount(1);
  await expect(packages.first()).toHaveAttribute("data-selected", "true");
  await expect(packages.first()).toContainText("Selected");

  // Tap: one unit. Stepper: several at once.
  await item.getByRole("button", { name: "Put one E2E item in the selected package" }).click();
  await expect(item.getByTestId("pack-left")).toHaveText("5 left");
  await item.getByRole("button", { name: "One more E2E item" }).click();
  await item.getByRole("button", { name: "One more E2E item" }).click();
  await item.getByRole("button", { name: "Put 3 here" }).click();
  await expect(item.getByTestId("pack-left")).toHaveText("2 left");
  await expect(packages.first()).toContainText("×4");
  await expect(page.getByTestId("pack-unassigned")).toHaveText("2 items unassigned");

  // A second package takes the rest: the one line is split, never changed.
  await addCustomPackage(page);
  await expect(packages).toHaveCount(2);
  await expect(packages.nth(1)).toHaveAttribute("data-selected", "true");
  await item.getByRole("button", { name: "Put one E2E item in the selected package" }).click();
  await expect(item.getByTestId("pack-where")).toHaveText("4 in #1 · 1 in #2");
  await item.getByRole("button", { name: "Put one E2E item in the selected package" }).click();
  await expect(page.getByTestId("pack-all-packed")).toBeVisible();
  await expect(packages.nth(1)).toContainText("×2");

  // Taking one back out returns it to the items.
  await page.getByRole("button", { name: "Take one E2E item out of package 2" }).click();
  await expect(item.getByTestId("pack-left")).toHaveText("1 left");
  await expect(packages.nth(1)).toContainText("×1");

  // Deleting package 2 returns its unit too.
  await page.getByRole("button", { name: "Actions for package 2" }).click();
  await page.getByRole("menuitem", { name: "Delete package" }).click();
  await page
    .getByRole("dialog", { name: "Delete package 2?" })
    .getByRole("button", { name: "Delete" })
    .click();
  await expect(packages).toHaveCount(1);
  await expect(item.getByTestId("pack-left")).toHaveText("2 left");

  // What's shown is what the server kept, and the order page shows the package's contents.
  await page.reload();
  await expect(page.getByTestId("pack-item").getByTestId("pack-left")).toHaveText("2 left");
  await page.goto(`/orders/${order.id}`);
  await expect(page.getByTestId("order-package-items")).toContainText("E2E item ×4");
});

test("a takeover elsewhere disables the pack screen without a reload", async ({
  page,
  browser,
}) => {
  const order = await startPacking(page, 2);
  await addCustomPackage(page);
  await expect(page.getByRole("button", { name: "Add package" })).toBeVisible();

  const other = await (await browser.newContext()).newPage();
  try {
    await signInAs(other, ["PACKER"]);
    await other.goto(`/orders/${order.id}`);
    await other.getByRole("button", { name: "Take over" }).click();
    await other
      .getByRole("dialog", { name: "Take over this order?" })
      .getByRole("button", { name: "Take over" })
      .click();
    await expect(other.getByText("Claimed by E2E PACKER")).toBeVisible();
  } finally {
    await other.context().close();
  }

  await expect(page.getByTestId("pack-banner")).toContainText("is working on this order");
  await expect(page.getByRole("button", { name: "Add package" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Put one E2E item in the selected package" }),
  ).toBeDisabled();
});

test("a weight over the box's max needs a reason; changing a weighed package asks to re-weigh", async ({
  page,
}) => {
  const box = await db.box.create({
    data: {
      name: `E2E Box ${crypto.randomUUID()}`,
      lengthIn: 12,
      widthIn: 9,
      heightIn: 4,
      maxWeightOz: 40,
    },
  });
  boxIds.push(box.id);
  await startPacking(page, 3);
  await page.getByRole("button", { name: "Add package" }).click();
  await page
    .getByRole("dialog", { name: "Choose a box" })
    .getByRole("button", { name: box.name })
    .click();
  const pkg = page.getByTestId("pack-package");
  await expect(pkg).toHaveCount(1);
  await expect(pkg.getByTestId("pack-max")).toHaveText("Max 2 lb 8 oz");
  await expect(page.getByTestId("pack-unweighed")).toHaveText("1 package without a weight");

  await page.getByRole("button", { name: "Put one E2E item in the selected package" }).click();
  await expect(pkg).toContainText("×1");

  // 3 lb is over the 2 lb 8 oz max: nothing saves without a reason.
  await pkg.getByLabel("lb", { exact: true }).fill("3");
  await pkg.getByRole("button", { name: "Save weight" }).click();
  const dialog = page.getByRole("dialog", { name: "Over the box's limit" });
  await dialog.getByRole("button", { name: "Save with reason" }).click();
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("pack-unweighed")).toHaveText("1 package without a weight");

  await dialog.getByLabel("Reason").fill("Dense kit, carrier agreed");
  await dialog.getByRole("button", { name: "Save with reason" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("pack-unweighed")).toHaveText("0 packages without a weight");
  await expect(pkg.getByTestId("pack-override")).toContainText("Dense kit, carrier agreed");
  await expect(pkg.getByTestId("pack-stale")).toHaveCount(0);

  // A unit added after weighing keeps the weight but asks to re-weigh or confirm it.
  await page.getByRole("button", { name: "Put one E2E item in the selected package" }).click();
  await expect(pkg.getByTestId("pack-stale")).toContainText("Contents changed since weighed");
  await pkg.getByRole("button", { name: "Weight still right" }).click();
  await expect(pkg.getByTestId("pack-stale")).toHaveCount(0);
  await expect(pkg.getByTestId("pack-override")).toContainText("Dense kit, carrier agreed");

  // What's shown is what the server kept.
  await page.reload();
  await expect(page.getByTestId("pack-unweighed")).toHaveText("0 packages without a weight");
  await expect(page.getByTestId("pack-package").getByLabel("lb", { exact: true })).toHaveValue("3");
});

test("the suggested box is listed first and adding it works; a weight far off the estimate warns", async ({
  page,
}) => {
  // Smaller than any other box, so it is the smallest fit for a 1 in cube.
  const tiny = await db.box.create({
    data: {
      name: `E2E Tiny ${crypto.randomUUID()}`,
      lengthIn: 1.5,
      widthIn: 1.5,
      heightIn: 1.5,
      maxWeightOz: 100,
      tareWeightOz: 2,
    },
  });
  const huge = await db.box.create({
    data: { name: `E2E Zlarge ${crypto.randomUUID()}`, lengthIn: 20, widthIn: 20, heightIn: 20 },
  });
  boxIds.push(tiny.id, huge.id);
  await startPacking(page, 1, { weightOz: 8, lengthIn: 1, widthIn: 1, heightIn: 1 });

  await page.getByRole("button", { name: "Add package" }).click();
  const dialog = page.getByRole("dialog", { name: "Choose a box" });
  const first = dialog.getByRole("listitem").first();
  await expect(first).toContainText(tiny.name);
  await expect(first.getByTestId("box-suggestion")).toContainText("Fits everything · est. 10 oz");
  await first.getByRole("button").click();
  await expect(dialog).toBeHidden();

  const pkg = page.getByTestId("pack-package");
  await expect(pkg).toHaveCount(1);
  await page.getByRole("button", { name: "Put one E2E item in the selected package" }).click();
  await expect(pkg.getByTestId("pack-estimate")).toHaveText("Est. 10 oz");

  // Within 25% of 10 oz: no warning. 3 lb is far off.
  await pkg.getByLabel("oz", { exact: true }).fill("11");
  await pkg.getByRole("button", { name: "Save weight" }).click();
  await expect(page.getByTestId("pack-unweighed")).toHaveText("0 packages without a weight");
  await expect(pkg.getByTestId("pack-weight-warning")).toHaveCount(0);

  await pkg.getByLabel("lb", { exact: true }).fill("1");
  await pkg.getByLabel("oz", { exact: true }).fill("0");
  await pkg.getByRole("button", { name: "Save weight" }).click();
  await expect(pkg.getByTestId("pack-weight-warning")).toContainText(
    "60% heavier than the estimate",
  );

/** Types `code` the way an HID scanner does: a fast burst of keys, then Enter. */
async function scanCode(page: Page, code: string) {
  await page.keyboard.type(code, { delay: 5 });
  await page.keyboard.press("Enter");
}

test("scans go into the selected package; a wrong scan shows red and changes nothing", async ({
  page,
}) => {
  await startPacking(page, 3);
  const banner = page.getByTestId("scan-banner");
  const item = page.getByTestId("pack-item");

  // With no package yet, a scan asks to add or pick one.
  await scanCode(page, "E2E-SKU");
  await expect(banner).toHaveAttribute("data-ok", "false");
  await expect(banner).toContainText("Add a package or pick one first");

  await addCustomPackage(page);
  await scanCode(page, "e2e-sku");
  await expect(banner).toHaveAttribute("data-ok", "true");
  await expect(banner).toContainText("Packed E2E item in package 1: 2 left");
  await expect(item.getByTestId("pack-left")).toHaveText("2 left");
  await scanCode(page, "E2E-SKU");
  await expect(item.getByTestId("pack-left")).toHaveText("1 left");
  await expect(page.getByTestId("pack-package").first()).toContainText("×2");

  await scanCode(page, "NOT-A-CODE-1");
  await expect(banner).toHaveAttribute("data-ok", "false");
  await expect(banner).toContainText("Woolrus doesn't know that code");
  await expect(item.getByTestId("pack-left")).toHaveText("1 left");

  // What's shown is what the server kept: the refused scan added nothing.
  await page.reload();
  await expect(page.getByTestId("pack-item").getByTestId("pack-left")).toHaveText("1 left");
  await expect(page.getByTestId("pack-package").first()).toContainText("×2");
});
