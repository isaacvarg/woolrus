import { expect, test } from "@playwright/test";
import { signInAs } from "./support/auth";
import { createOrder, deleteCreatedOrders } from "./support/orders";

// The home dashboard: live counts, orders per day, and big buttons into each queue.

test.afterAll(() => deleteCreatedOrders());

test("the dashboard counts open work, charts orders per day and opens each queue", async ({
  page,
}) => {
  // Today's order guarantees a non-zero day on the chart.
  await createOrder({ status: "PACKING" });
  await signInAs(page, ["PICKER"]);
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Dashboard", level: 1 })).toBeVisible();
  for (const tile of ["open", "picking", "packing", "qa", "issues"]) {
    await expect(page.getByTestId(`tile-${tile}`)).toHaveText(/\d/);
  }
  await expect(page.getByTestId("tile-packing").locator("dd").first()).not.toHaveText("0");

  // The chart's figures are in its table: 14 days by default, 30 on the toggle.
  const chart = page.getByRole("figure", { name: "Orders per day, last 14 days" });
  await expect(chart.getByRole("row")).toHaveCount(15);
  await page.getByRole("radio", { name: "30 days" }).click();
  await expect(
    page.getByRole("figure", { name: "Orders per day, last 30 days" }).getByRole("row"),
  ).toHaveCount(31);

  const queues = page.getByRole("region", { name: "Queues" });
  for (const name of [
    "Pending",
    "Picking",
    "Packing",
    "QA",
    "Ready",
    "On Hold",
    "Voids",
    "Issues",
  ]) {
    await expect(queues.getByRole("link", { name: new RegExp(`^${name}`) })).toBeVisible();
  }
  await queues.getByRole("link", { name: /^Packing/ }).click();
  await expect(page).toHaveURL("/queue/packing");
});
