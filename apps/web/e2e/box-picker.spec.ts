import { expect, type Locator, type Page, test } from "@playwright/test";
import { createDb } from "@woolrus/db";
import { signInAs } from "./support/auth";
import { openNav } from "./support/nav";
import { createOrder, deleteCreatedOrders } from "./support/orders";

// SPEC-packing A2, criterion 35: columns, the highlighted suggestion, and the group sections.

const db = createDb();
const boxIds: string[] = [];
const groupIds: string[] = [];

test.afterAll(async () => {
  await deleteCreatedOrders();
  await db.box.deleteMany({ where: { id: { in: boxIds.splice(0) }, packages: { none: {} } } });
  // A box left behind because a package used it just becomes ungrouped.
  await db.boxGroup.deleteMany({ where: { id: { in: groupIds.splice(0) } } });
});

type TinyOptions = { groupId?: string | null; side?: number };

/** Smaller than any other box, so it is the suggestion for a 1 in cube. */
async function tinyBox(name: string, { groupId = null, side = 1.2 }: TinyOptions = {}) {
  const box = await db.box.create({
    data: { name, lengthIn: side, widthIn: side, heightIn: side, maxWeightOz: 100, groupId },
  });
  boxIds.push(box.id);
  return box;
}

/** A one-item order in Packing, opened on the pack screen by a fresh packer. */
async function startPacking(page: Page) {
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
}

/** Puts the order's one item in package 1 and opens Change box, which suggests from its contents. */
async function openChangeBox(page: Page) {
  await page
    .getByTestId("pack-item")
    .getByRole("button", { name: /^Put one .+ in the selected package$/ })
    .click();
  await expect(page.getByTestId("pack-all-packed")).toBeVisible();
  await page.getByRole("button", { name: "Actions for package 1" }).click();
  await page.getByRole("menuitem", { name: "Change box" }).click();
  return page.getByRole("dialog", { name: "Change the box of package 1" });
}

const suggestedBox = (dialog: Locator) =>
  dialog.getByRole("button").filter({ has: dialog.page().getByTestId("box-suggestion") });

/** How many columns the box grid lays out, as the browser computed them. */
const columnCount = (grid: Locator) =>
  grid.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);

async function expectPicker(dialog: Locator, columns: number) {
  const suggested = suggestedBox(dialog);
  // The dev data has groups, so there is a grid per section; the first is right below.
  const grids = dialog.getByTestId("box-grid");
  const grid = grids.first();
  await expect(suggested).toContainText("E2E Picker tiny");
  await expect(suggested).toContainText("Suggested");
  await expect.poll(() => columnCount(grid)).toBe(columns);

  // First and as wide as the whole grid, in either layout; not repeated below.
  const top = await suggested.boundingBox();
  const area = await grid.boundingBox();
  expect(top && area && top.y < area.y).toBe(true);
  expect(top && area && Math.abs(top.width - area.width) <= 1).toBe(true);
  await expect(grids.getByText(/E2E Picker tiny/)).toHaveCount(0);
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
  await tinyBox(`E2E Picker tiny ${crypto.randomUUID()}`);
  await startPacking(page);

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
  await suggestedBox(add).click();
  await expect(add).toBeHidden();

  const change = await openChangeBox(page);
  await expectPicker(change, 2);

  // A phone in portrait: two columns drop to one below 480 px.
  await page.setViewportSize({ width: 375, height: 812 });
  await expectPicker(change, 1);
});

/** The section headings from top to bottom, without Custom size. */
const sectionHeadings = (dialog: Locator) =>
  dialog.getByRole("group").getByRole("heading", { level: 3 }).allTextContents();

async function expectGroups(dialog: Locator, names: { first: string; second: string }) {
  const { first, second } = names;
  // The suggestion is on top and not repeated in its group.
  await expect(suggestedBox(dialog)).toContainText(`${second} tiny`);
  const top = await suggestedBox(dialog).boundingBox();
  const firstGroup = dialog.getByRole("group", { name: first });
  const secondGroup = dialog.getByRole("group", { name: second });
  const area = await firstGroup.boundingBox();
  expect(top && area && top.y < area.y).toBe(true);
  await expect(secondGroup.getByRole("button")).toHaveText([new RegExp(`${second} spare`)]);
  await expect(firstGroup.getByRole("button")).toHaveText([new RegExp(`${first} box`)]);

  // The admin's order (position, not name), and "Other boxes" last with the ungrouped box.
  const headings = await sectionHeadings(dialog);
  expect(headings.indexOf(first)).toBeGreaterThanOrEqual(0);
  expect(headings.indexOf(first)).toBeLessThan(headings.indexOf(second));
  expect(headings.at(-1)).toBe("Other boxes");
  await expect(dialog.getByRole("group", { name: "Other boxes" })).toContainText(`${second} loose`);
  // Custom size comes after every section.
  const custom = await dialog.getByRole("heading", { name: "Custom size" }).boundingBox();
  const other = await dialog.getByRole("group", { name: "Other boxes" }).boundingBox();
  expect(custom && other && other.y < custom.y).toBe(true);
}

test("Box picker groups: the suggestion, then the groups in the admin's order, then Other boxes", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "tablet", "the floor's tablets; one run is enough");
  const run = crypto.randomUUID().slice(0, 8);
  // Named against their position, so the order shown can only come from the position.
  const first = `E2E Z group ${run}`;
  const second = `E2E A group ${run}`;
  const top = await db.boxGroup.aggregate({ _max: { position: true } });
  const base = (top._max.position ?? 0) + 1;
  const firstGroup = await db.boxGroup.create({ data: { name: first, position: base } });
  const secondGroup = await db.boxGroup.create({ data: { name: second, position: base + 1 } });
  groupIds.push(firstGroup.id, secondGroup.id);

  // Smaller still than the columns test's tiny box, which stays until the file ends.
  await tinyBox(`${second} tiny`, { groupId: secondGroup.id, side: 1.1 });
  // Bigger than the tiny box, so they're never the suggestion.
  for (const [name, groupId] of [
    [`${second} spare`, secondGroup.id],
    [`${first} box`, firstGroup.id],
    [`${second} loose`, null],
  ] as const) {
    const box = await db.box.create({
      data: { name, lengthIn: 30, widthIn: 30, heightIn: 30, maxWeightOz: 1000, groupId },
    });
    boxIds.push(box.id);
  }

  await startPacking(page);
  await page.getByRole("button", { name: "Add package" }).click();
  const add = page.getByRole("dialog", { name: "Choose a box" });
  await expectGroups(add, { first, second });
  await suggestedBox(add).click();
  await expect(add).toBeHidden();

  await expectGroups(await openChangeBox(page), { first, second });
});
