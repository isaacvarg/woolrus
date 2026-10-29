import { expect, test } from "@playwright/test";
import { signInAs } from "./support/auth";
import { createOrder, deleteCreatedOrders, markAnonymized } from "./support/orders";

test.afterAll(deleteCreatedOrders);

test("an anonymized order reads 'Customer details removed' in the list and on its page, with no address", async ({
  page,
}) => {
  const order = await createOrder({});
  await markAnonymized(order.id);
  await signInAs(page, ["ADMIN"]);

  await page.goto(`/orders?search=${order.number}`);
  const row = page.getByRole("row", { name: new RegExp(order.number) });
  await expect(row).toContainText("Customer details removed");

  await page.goto(`/orders/${order.id}`);
  await expect(page.getByTestId("order-customer")).toHaveText("Customer details removed");
  await expect(page.getByText("Ship to", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Main St")).toHaveCount(0);
});
