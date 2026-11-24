import { expect, type Locator, type Page, test } from "@playwright/test";
import { createDb } from "@woolrus/db";
import { signInAs } from "./support/auth";
import { openNav } from "./support/nav";
import { createOrder, deleteCreatedOrders } from "./support/orders";

// SPEC-packing A2, criterion 35 (columns and the highlighted suggestion; groups come with #228).

const db = createDb();
const boxIds: string[] = [];

test.afterAll(async () => {
  await deleteCreatedOrders();
  await db.box.deleteMany({ where: { id: { in: boxIds.splice(0) }, packages: { none: {} } } });
});

/** How many columns the box grid lays out, as the browser computed them. */
const columnCount = (grid: Locator) =>
  grid.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);

async function expectPicker(dialog: Locator, columns: number) {
  const suggested = dialog
    .getByRole("button")
    .filter({ has: dialog.page().getByTestId("box-suggestion") });
  const grid = dialog.getByTestId("box-grid");
  await expect(suggested).toContainText("E2E Picker tiny");
  await expect(suggested).toContainText("Suggested");
  await expect.poll(() => columnCount(grid)).toBe(columns);

  // First and as wide as the whole grid, in either layout; not repeated below.
  const top = await suggested.boundingBox();
  const area = await grid.boundingBox();
  expect(top && area && top.y < area.y).toBe(true);
  expect(top && area && Math.abs(top.width - area.width) <= 1).toBe(true);
  await expect(grid.getByText(/E2E Picker tiny/)).toHaveCount(0);
}

async function setColumns(page: Page, label: string) {
  await openNav(page);
  await page.getByRole("button", { name: "Preferences" }).click();
  await page.getByRole("menuitemradio", { name: label }).click();
  await page.keyboard.press("Escape");
}

test("Box picker columns: two columns with the suggestion first and full width; one on a phone", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "tablet", "the floor's tablets; one run is enough");
  // Smaller than any other box, so it is the suggestion for a 1 in cube.
  const tiny = await db.box.create({
    data: {
      name: `E2E Picker tiny ${crypto.randomUUID()}`,
      lengthIn: 1.2,
      widthIn: 1.2,
      heightIn: 1.2,
      maxWeightOz: 100,
    },
  });
  boxIds.push(tiny.id);
  const customerName = `E2E ${crypto.randomUUID()}`;
  const order = await createOrder({
    customerName,
    quantity: 1,
    status: "PACKING",
    productSize: { weightOz: 4, lengthIn: 1, widthIn: 1, heightIn: 1 },
  });
  await signInAs(page, ["PACKER"]);
  await page.goto("/queue/packing");
  await page.getByRole("searchbox", { name: "Search orders" }).fill(customerName);
  await page
    .getByRole("row", { name: new RegExp(order.number) })
    .getByRole("button", { name: "Start packing" })
    .click();
  // The first load of the pack screen compiles it in dev.
  await expect(page).toHaveURL(`/pack/${order.id}`, { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: `Pack #${order.number}` })).toBeVisible();

  // The default is one column.
  await page.getByRole("button", { name: "Add package" }).click();
  const add = page.getByRole("dialog", { name: "Choose a box" });
  await expectPicker(add, 1);
  await add.getByRole("button", { name: "Back" }).click();
  await expect(add).toBeHidden();

  await setColumns(page, "2 columns");
  // Saved on the user: a reload still has it.
  await page.reload();
  await page.getByRole("button", { name: "Add package" }).click();
  await expectPicker(add, 2);
  await add
    .getByRole("button")
    .filter({ has: page.getByTestId("box-suggestion") })
    .click();
  await expect(add).toBeHidden();

  // Change box suggests from the package's own contents, so put the item in it first.
  await page
    .getByTestId("pack-item")
    .getByRole("button", { name: /^Put one .+ in the selected package$/ })
    .click();
  await expect(page.getByTestId("pack-all-packed")).toBeVisible();

  await page.getByRole("button", { name: "Actions for package 1" }).click();
  await page.getByRole("menuitem", { name: "Change box" }).click();
  const change = page.getByRole("dialog", { name: "Change the box of package 1" });
  await expectPicker(change, 2);

  // A phone in portrait: two columns drop to one below 480 px.
  await page.setViewportSize({ width: 375, height: 812 });
  await expectPicker(change, 1);
});
