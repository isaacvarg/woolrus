import { expect, test } from "@playwright/test";
import { createDb } from "@woolrus/db";
import { signInAs } from "./support/auth";
import { createOrder, deleteCreatedOrders } from "./support/orders";

const db = createDb();
const prefix = `E2E box ${crypto.randomUUID().slice(0, 8)}`;

test.afterAll(async () => {
  await deleteCreatedOrders();
  await db.box.deleteMany({ where: { name: { startsWith: prefix } } });
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
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toBeHidden();
  await expect(page.getByRole("row", { name: new RegExp(`${name} renamed`) })).toContainText(
    "In use",
  );
});
