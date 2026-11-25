import { expect, test } from "@playwright/test";
import { createDb } from "@woolrus/db";
import { signInAs } from "./support/auth";
import { createOrder, deleteCreatedOrders } from "./support/orders";

const db = createDb();
const prefix = `E2E box ${crypto.randomUUID().slice(0, 8)}`;

test.afterAll(async () => {
  await deleteCreatedOrders();
  await db.box.deleteMany({ where: { name: { startsWith: prefix } } });
  await db.boxGroup.deleteMany({ where: { name: { startsWith: prefix } } });
});

test("an admin creates, edits, archives, restores and deletes an unused box", async ({
  page,
}, info) => {
  const name = `${prefix} ${info.project.name}`;
  await signInAs(page, ["ADMIN"]);
  await page.goto("/boxes");
  await page.getByRole("button", { name: "Add box" }).click();
  const dialog = page.getByRole("dialog", { name: "Add box" });
  await dialog.getByLabel("Name").fill(name);
  const inner = dialog.getByRole("group", { name: "Inner dimensions (in)" });
  await inner.getByLabel("Length").fill("10");
  await inner.getByLabel("Width").fill("8");
  await inner.getByLabel("Height").fill("4");
  const outer = dialog.getByRole("group", { name: /Outer dimensions/ });
  await outer.getByLabel("Length").fill("10.5");
  await outer.getByLabel("Width").fill("8.5");
  await outer.getByLabel("Height").fill("4.5");
  await dialog.getByLabel("Tare (oz)").fill("5");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();

  const row = page.getByRole("row", { name: new RegExp(name) });
  await expect(row).toContainText("10 × 8 × 4");
  await expect(row).toContainText("10.5 × 8.5 × 4.5");
  await expect(row).not.toContainText("In use");

  // Edit: an outer size smaller than the inner one is refused.
  await row.getByRole("button", { name: "Edit" }).click();
  const edit = page.getByRole("dialog", { name: "Edit" });
  await edit
    .getByRole("group", { name: /Outer dimensions/ })
    .getByLabel("Length")
    .fill("9");
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit.getByRole("alert")).toContainText("outer size can't be smaller");
  await edit
    .getByRole("group", { name: /Outer dimensions/ })
    .getByLabel("Length")
    .fill("10.5");
  await edit.getByLabel("Name").fill(`${name} v2`);
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toBeHidden();
  const renamed = page.getByRole("row", { name: new RegExp(`${name} v2`) });
  await expect(renamed).toBeVisible();

  await renamed.getByRole("button", { name: "Archive" }).click();
  await expect(renamed).toBeHidden();
  await page.getByText("Show archived").click();
  await expect(renamed).toContainText("Archived");
  await renamed.getByRole("button", { name: "Restore" }).click();
  await expect(renamed).not.toContainText("Archived");

  await renamed.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(renamed).toBeHidden();
});

test("a box a package uses shows In use, locks dimensions and offers archive only", async ({
  page,
}, info) => {
  const name = `${prefix} used ${info.project.name}`;
  const box = await db.box.create({
    data: { name, lengthIn: 10, widthIn: 8, heightIn: 4 },
  });
  const order = await createOrder({ customerName: `E2E ${crypto.randomUUID()}`, quantity: 1 });
  await db.package.create({ data: { orderId: order.id, number: 1, boxId: box.id } });

  await signInAs(page, ["ADMIN"]);
  await page.goto("/boxes");
  const row = page.getByRole("row", { name: new RegExp(name) });
  await expect(row).toContainText("In use");
  await expect(row.getByRole("button", { name: "Delete" })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Archive" })).toBeVisible();

  await row.getByRole("button", { name: "Edit" }).click();
  const edit = page.getByRole("dialog", { name: "Edit" });
  await expect(edit.getByTestId("box-locked")).toBeVisible();
  await expect(
    edit.getByRole("group", { name: "Inner dimensions (in)" }).getByLabel("Length"),
  ).toBeDisabled();
  await edit.getByLabel("Name").fill(`${name} renamed`);
  // The min weight stays editable on a box in use (SPEC-packing A1).
  await edit.getByLabel("Min weight (oz)").fill("12");
  // So does the barcode, stored as a scan compares it.
  const barcode = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  await edit.getByLabel("Barcode").fill(barcode);
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toBeHidden();
  const renamed = page.getByRole("row", { name: new RegExp(`${name} renamed`) });
  await expect(renamed).toContainText("In use");
  await expect(renamed).toContainText("12 oz");
  await expect(renamed).toContainText(barcode.toUpperCase());
});

test("an admin groups boxes, reorders the groups and deletes one (SPEC-packing A2)", async ({
  page,
}, info) => {
  // Groups share one order across the store, so one project runs this, without a neighbour
  // created in between.
  test.skip(info.project.name !== "desktop", "the desktop admin journey");
  const groupA = `${prefix} Cartons`;
  const groupB = `${prefix} Mailers`;
  const [carton, mailer, loose] = ["carton", "mailer", "loose"].map((n) => `${prefix} ${n}`);
  for (const name of [carton, mailer, loose] as string[]) {
    await db.box.create({ data: { name, lengthIn: 10, widthIn: 8, heightIn: 4 } });
  }

  await signInAs(page, ["ADMIN"]);
  await page.goto("/boxes");
  const panel = page.getByRole("region", { name: "Groups" });
  for (const name of [groupA, groupB]) {
    await panel.getByRole("button", { name: "Add group" }).click();
    const dialog = page.getByRole("dialog", { name: "Add group" });
    await dialog.getByLabel("Group name").fill(name);
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();
  }
  const group = (name: string) => panel.getByTestId("box-group").filter({ hasText: name });
  await expect(group(groupB)).toContainText("0 boxes");

  // A duplicate ignoring case is refused.
  await panel.getByRole("button", { name: "Add group" }).click();
  const dup = page.getByRole("dialog", { name: "Add group" });
  await dup.getByLabel("Group name").fill(groupA.toUpperCase());
  await dup.getByRole("button", { name: "Save" }).click();
  await expect(dup.getByRole("alert")).toContainText("already exists");
  await dup.getByRole("button", { name: "Cancel" }).click();

  const assign = async (box: string, groupName: string) => {
    await page
      .getByRole("row", { name: new RegExp(box) })
      .getByRole("button", { name: "Edit" })
      .click();
    const edit = page.getByRole("dialog", { name: "Edit" });
    await edit.getByRole("button", { name: /Group/ }).click();
    await page.getByRole("option", { name: groupName }).click();
    await edit.getByRole("button", { name: "Save" }).click();
    await expect(edit).toBeHidden();
  };
  await assign(carton as string, groupA);
  await assign(mailer as string, groupB);
  await expect(page.getByRole("row", { name: new RegExp(carton as string) })).toContainText(groupA);
  await expect(page.getByRole("row", { name: new RegExp(loose as string) })).toContainText("—");
  await expect(group(groupB)).toContainText("1 box");

  // The second group moves above the first.
  const mine = async () =>
    (await panel.getByTestId("box-group").allTextContents()).filter((t) => t.includes(prefix));
  expect((await mine())[0]).toContain(groupA);
  await group(groupB).getByRole("button", { name: "Move up" }).click();
  await expect.poll(async () => (await mine())[0]).toContain(groupB);

  // Deleting a group ungroups its box and deletes none.
  await group(groupB).getByRole("button", { name: "Delete" }).click();
  const confirm = page.getByRole("dialog", { name: /Delete the group/ });
  await expect(confirm).toContainText("1 box will move to Other boxes.");
  await confirm.getByRole("button", { name: "Delete" }).click();
  await expect(group(groupB)).toHaveCount(0);
  const mailerRow = page.getByRole("row", { name: new RegExp(mailer as string) });
  await expect(mailerRow).toBeVisible();
  await expect(mailerRow).not.toContainText(groupB);
});
