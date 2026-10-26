import { expect, test } from "@playwright/test";
import { createDb } from "@woolrus/db";
import { signInAs } from "./support/auth";
import { createOrder, deleteCreatedOrders } from "./support/orders";

const db = createDb();

test.afterAll(deleteCreatedOrders);

test("a picker voids 1 of 3 from the order detail, then undoes it", async ({ page }) => {
  const order = await createOrder({ quantity: 3 });
  await signInAs(page, ["PICKER"]);
  await page.goto(`/orders/${order.id}`);

  const line = page.getByRole("row", { name: /E2E item/ });
  await expect(line.getByRole("cell", { name: "3", exact: true }).last()).toBeVisible();
  await line.getByRole("button", { name: "Void" }).click();

  const dialog = page.getByRole("dialog", { name: "Void E2E item" });
  const quantity = dialog.getByRole("textbox", { name: "How many to void" });
  // The whole active quantity is the default; one unit is the missing jar.
  await expect(quantity).toHaveValue("3");
  await quantity.fill("1");
  await dialog.getByRole("radio", { name: "Out of stock" }).click();
  await expect(dialog.getByRole("textbox", { name: "Reason", exact: true })).toHaveValue(
    "Out of stock",
  );
  await dialog.getByRole("button", { name: "Void", exact: true }).click();

  await expect(page.getByText("1 of 3 voided: Out of stock")).toBeVisible();
  await expect(line.getByRole("cell", { name: "2", exact: true })).toBeVisible();

  await line.getByRole("button", { name: "Undo" }).click();

  await expect(page.getByText("1 of 3 voided: Out of stock")).toHaveCount(0);
  await expect(line.getByRole("cell", { name: "3", exact: true })).toHaveCount(2);
});

test("a completed order offers no void", async ({ page }) => {
  const order = await createOrder({ status: "COMPLETED" });
  await signInAs(page, ["ADMIN"]);
  await page.goto(`/orders/${order.id}`);

  await expect(page.getByRole("row", { name: /E2E item/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Void" })).toHaveCount(0);
});

test("a packer voids a boxed unit from the pack screen and sees the re-weigh flag", async ({
  page,
}) => {
  const order = await createOrder({ quantity: 3, status: "PACKING" });
  const item = await db.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
  const pkg = await db.package.create({
    data: { orderId: order.id, number: 1, lengthIn: 12, widthIn: 9, heightIn: 4, weightOz: 16 },
  });
  await db.packageItem.create({
    data: { packageId: pkg.id, orderItemId: item.id, quantity: 2 },
  });
  // Nobody holds a claim: voiding needs none.
  await signInAs(page, ["PACKER"]);
  await page.goto(`/pack/${order.id}`);

  const card = page.getByTestId("pack-item");
  await expect(card.getByTestId("pack-left")).toHaveText("1 left");
  await card.getByRole("button", { name: "Void" }).click();
  const dialog = page.getByRole("dialog", { name: "Void E2E item" });
  await dialog.getByRole("textbox", { name: "How many to void" }).fill("2");
  await dialog.getByRole("radio", { name: "Damaged" }).click();
  await dialog.getByRole("button", { name: "Void", exact: true }).click();

  // 3 -> 1 active: the unassigned unit and one boxed unit are gone, the weight stays flagged.
  await expect(page.getByTestId("pack-stale")).toBeVisible();
  await expect(page.getByTestId("pack-all-packed")).toBeVisible();
});

test("voiding every line shows the all-voided banner, hides Complete, and the order can be cancelled", async ({
  page,
}) => {
  const order = await createOrder({ status: "PICKING", quantity: 1 });
  await signInAs(page, ["ADMIN"]);
  await page.goto(`/orders/${order.id}`);

  await page
    .getByRole("row", { name: /E2E item/ })
    .getByRole("button", { name: "Void" })
    .click();
  const dialog = page.getByRole("dialog", { name: "Void E2E item" });
  await dialog.getByRole("radio", { name: "Out of stock" }).click();
  await dialog.getByRole("button", { name: "Void", exact: true }).click();

  await expect(page.getByTestId("all-voided-banner")).toContainText("Every item is voided");
  await expect(page.getByRole("button", { name: /^Complete/ })).toHaveCount(0);

  await page.getByRole("button", { name: "Cancel order" }).click();
  const cancel = page.getByRole("dialog", { name: "Cancel this order" });
  await cancel.getByRole("textbox", { name: "Reason" }).fill("Nothing left to ship");
  await cancel.getByRole("button", { name: "Cancel order" }).click();
  await expect(page.getByTestId("order-status")).toHaveText("Cancelled");
});
