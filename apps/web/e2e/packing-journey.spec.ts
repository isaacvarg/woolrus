import { expect, type Page, test } from "@playwright/test";
import { createDb } from "@woolrus/db";
import { signInAs } from "./support/auth";
import { createOrder, deleteCreatedOrders } from "./support/orders";

const db = createDb();
const boxIds: string[] = [];

test.beforeAll(async () => {
  // A run that died before its cleanup leaves boxes behind, and same-sized boxes tie in the
  // suggestion. Only old ones go, so a worker still using its own box isn't disturbed.
  await db.box.deleteMany({
    where: {
      name: { startsWith: "E2E " },
      createdAt: { lt: new Date(Date.now() - 10 * 60_000) },
      packages: { none: {} },
    },
  });
});

test.afterAll(async () => {
  await deleteCreatedOrders();
  await db.box.deleteMany({ where: { id: { in: boxIds.splice(0) }, packages: { none: {} } } });
});

/** Types `code` the way an HID scanner does: a fast burst of keys, then Enter. */
async function scanCode(page: Page, code: string) {
  await page.keyboard.type(code, { delay: 5 });
  await page.keyboard.press("Enter");
}

/**
 * Closes any toast before a tap. A success toast sits bottom right, and React Aria keeps it open
 * while the pointer rests on it, so one that lands over the next button would block the click.
 */
async function clearToasts(page: Page) {
  for (const dismiss of await page.getByRole("button", { name: "Dismiss" }).all()) {
    await dismiss.click({ timeout: 1_000 }).catch(() => {});
  }
}

// SPEC-packing criterion 16: picking → pack screen → box → scans → split → weights → re-weigh →
// Done, next order → the first order is in QA with its packages on the detail page.
test("pick, pack into two boxes, weigh, confirm a re-weigh and finish to the next order", async ({
  page,
}, testInfo) => {
  // Pick, pack, weigh and finish in one go: about 14 s alone, several times that on a CI runner.
  test.setTimeout(120_000);
  // A timeout names no step, so progress goes to the log: the last line says where it stopped.
  const progress = (step: string) => console.log(`[${testInfo.project.name}] journey: ${step}`);
  // Both projects run at once and see each other's boxes, so each sizes its units and box so that
  // its own box is the only smallest fit: the tablet's cubes (1.5 in) don't fit the desktop's box.
  const edge = testInfo.project.name === "tablet" ? 3 : 2;
  const unit = testInfo.project.name === "tablet" ? 1.5 : 1;
  // 4 units of 8 oz fit a 40 oz box (4 × 8 + 2 tare = 34), so it is suggested.
  const box = await db.box.create({
    data: {
      name: `E2E Journey ${crypto.randomUUID()}`,
      lengthIn: edge,
      widthIn: edge,
      heightIn: edge,
      maxWeightOz: 40,
      tareWeightOz: 2,
    },
  });
  boxIds.push(box.id);
  const customerName = `E2E ${crypto.randomUUID()}`;
  const order = await createOrder({
    customerName,
    quantity: 4,
    productSize: { weightOz: 8, lengthIn: unit, widthIn: unit, heightIn: unit },
  });
  // Above anything else in the shared Packing queue, so it is what "next" opens.
  await createOrder({
    status: "PACKING",
    priority: 2_000_000_000,
    orderedAt: new Date(2000, 0, 1),
  });

  await signInAs(page, ["PICKER", "PACKER"]);
  await page.goto("/queue/pending");
  await page.getByRole("searchbox", { name: "Search orders" }).fill(customerName);
  await page
    .getByRole("row", { name: new RegExp(order.number) })
    .getByRole("button", { name: "Begin Picking" })
    .click();
  await expect(page).toHaveURL(`/pick/${order.id}`, { timeout: 20_000 });
  progress("picking");
  await page
    .getByTestId("pick-card")
    .getByRole("button", { name: /^E2E item/ })
    .click();
  await expect(page.getByTestId("pick-progress")).toHaveText("1 of 1 lines picked");
  await page.getByRole("button", { name: "Done, open in Packing" }).click();
  await expect(page).toHaveURL(`/pack/${order.id}`, { timeout: 20_000 });
  progress("pack screen");

  // The suggested box first; add it, scan two units into it.
  await page.getByRole("button", { name: "Add package" }).click();
  const dialog = page.getByRole("dialog", { name: "Choose a box" });
  const first = dialog.getByRole("listitem").first();
  // Any journey box will do: they are the same size when runs overlap, and ties go by name.
  await expect(first).toContainText("E2E Journey");
  await first.getByRole("button").click();
  await expect(dialog).toBeHidden();
  await scanCode(page, "E2E-SKU");
  await scanCode(page, "E2E-SKU");
  const packages = page.getByTestId("pack-package");
  await expect(packages.first()).toContainText("×2");
  progress("two units scanned into package 1");

  // A second package takes the rest, so the line is split. Nothing is finished yet: two warnings
  // show and Done is hidden.
  await page.getByRole("button", { name: "Add package" }).click();
  const custom = page.getByRole("dialog", { name: "Choose a box" });
  await custom.getByLabel("Length").fill("12");
  await custom.getByLabel("Width").fill("9");
  await custom.getByLabel("Height").fill("4");
  await custom.getByRole("button", { name: "Use this size" }).click();
  await expect(packages).toHaveCount(2);
  await page.getByRole("button", { name: "Put one E2E item in the selected package" }).click();
  await expect(page.getByTestId("pack-where")).toHaveText("2 in #1 · 1 in #2");
  await expect(page.getByTestId("pack-unassigned")).toHaveText("1 item unassigned");
  await expect(page.getByTestId("pack-unweighed")).toHaveText("2 packages without a weight");
  await expect(page.getByRole("button", { name: "Done, next order" })).toHaveCount(0);
  await page.getByRole("button", { name: "Put one E2E item in the selected package" }).click();
  await expect(page.getByTestId("pack-all-packed")).toBeVisible();
  progress("line split across two packages");
  await expect(page.getByRole("button", { name: "Done, next order" })).toHaveCount(0);

  // Over package 1's 40 oz max: refused until a reason is given.
  const one = packages.first();
  await one.getByLabel("lb", { exact: true }).fill("3");
  await one.getByLabel("oz", { exact: true }).fill("0");
  await one.getByRole("button", { name: "Save weight" }).click();
  const over = page.getByRole("dialog", { name: "Over the box's limit" });
  await over.getByRole("button", { name: "Save with reason" }).click();
  await expect(over).toBeVisible();
  await over.getByLabel("Reason").fill("Dense kit, carrier agreed");
  await over.getByRole("button", { name: "Save with reason" }).click();
  await expect(over).toBeHidden();
  await expect(page.getByTestId("pack-unweighed")).toHaveText("1 package without a weight");
  progress("overweight saved with a reason");

  // Weigh the other; the gate is met and the Done buttons appear.
  const two = packages.nth(1);
  await two.getByLabel("lb", { exact: true }).fill("1");
  await two.getByLabel("oz", { exact: true }).fill("0");
  await two.getByRole("button", { name: "Save weight" }).click();
  await expect(page.getByTestId("pack-unweighed")).toHaveText("0 packages without a weight");
  await expect(page.getByRole("button", { name: "Done, next order" })).toBeVisible();
  progress("gate met, Done buttons shown");

  // Swap a unit in the weighed package: it asks to re-weigh; confirming clears it.
  await clearToasts(page);
  await page.getByRole("button", { name: "Take one E2E item out of package 2" }).click();
  await page.getByRole("button", { name: "Put one E2E item in the selected package" }).click();
  await expect(two.getByTestId("pack-stale")).toBeVisible();
  await clearToasts(page);
  await two.getByRole("button", { name: "Weight still right" }).click();
  await expect(two.getByTestId("pack-stale")).toHaveCount(0);
  progress("re-weigh confirmed");

  // A flagged weight left unconfirmed gets a note for QA when the order finishes.
  await clearToasts(page);
  await page.getByRole("button", { name: "Take one E2E item out of package 2" }).click();
  await page.getByRole("button", { name: "Put one E2E item in the selected package" }).click();
  await expect(two.getByTestId("pack-stale")).toBeVisible();

  await clearToasts(page);
  await page.getByRole("button", { name: "Done, next order" }).click();
  await expect(page).toHaveURL(/\/pack\/[0-9a-f-]{36}$/, { timeout: 20_000 });
  await expect(page).not.toHaveURL(`/pack/${order.id}`);
  await expect(page.getByRole("heading", { name: /^Pack #/ })).toBeVisible();
  progress("next order opened");
  // Claimed for this packer: the screen is live, no banner.
  await expect(page.getByRole("button", { name: "Add package" })).toBeVisible();

  // The first order is in QA with both packages, and QA can see the re-weigh note.
  await page.goto(`/orders/${order.id}`);
  await expect(page.getByTestId("order-status")).toHaveText("QA");
  await expect(page.getByTestId("order-package")).toHaveCount(2);
  await expect(page.getByTestId("order-package").first()).toContainText("E2E item ×2");
  await expect(
    page.getByText("Contents changed after weighing; weight 1 lb not re-checked"),
  ).toBeVisible();
});

test("Done goes back to the Packing queue", async ({ page }) => {
  const customerName = `E2E ${crypto.randomUUID()}`;
  const order = await createOrder({ customerName, quantity: 1, status: "PACKING" });
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
  await page.goto(`/orders/${order.id}`);
  await expect(page.getByTestId("order-status")).toHaveText("QA");
});
