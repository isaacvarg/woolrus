import { expect, test } from "@playwright/test";
import { createDb } from "@woolrus/db";
import { signInAs } from "./support/auth";
import { createOrder, deleteCreatedOrders } from "./support/orders";
import { withSettingsLock } from "./support/settings-lock";

const db = createDb();

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

test("a packer sees orders past their SLA above the tiles and taps through to the queue", async ({
  page,
}) => {
  await signInAs(page, ["PACKER"]);
  await withSettingsLock(async () => {
    const before = await db.settings.findUnique({ where: { id: 1 } });
    const slas = { ...(before?.stageSlaMinutes as object | null), PACKING: 60 };
    await db.settings.upsert({
      where: { id: 1 },
      create: { id: 1, stageSlaMinutes: slas },
      update: { stageSlaMinutes: slas },
    });
    try {
      await createOrder({
        status: "PACKING",
        statusChangedAt: new Date(Date.now() - 2 * 3_600_000),
      });
      await page.goto("/");

      // Other tests' orders may be late too: the count is at least ours.
      const alert = page.getByRole("status", { name: "Orders past their stage's time limit" });
      await expect(alert).toContainText(/past SLA$/);
      const packing = alert.getByRole("link", { name: /^\d+ in Packing$/ });
      await expect(packing).toBeVisible();
      expect((await packing.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      await packing.click();
      await expect(page).toHaveURL("/queue/packing");
    } finally {
      await db.settings.update({
        where: { id: 1 },
        data: { stageSlaMinutes: before?.stageSlaMinutes ?? {} },
      });
    }
  });
});

test("a Reports holder gets the shipped-today and cycle-time tiles; a picker doesn't", async ({
  page,
}) => {
  await signInAs(page, ["PICKER"]);
  await page.goto("/");
  await expect(page.getByTestId("tile-open")).toHaveText(/\d/);
  await expect(page.getByTestId("tile-shipped-today")).toHaveCount(0);
  await expect(page.getByTestId("tile-median-cycle")).toHaveCount(0);

  await signInAs(page, ["PACKER", "REPORTS"]);
  await page.goto("/");
  const shipped = page.getByTestId("tile-shipped-today");
  await expect(shipped.locator("dd").first()).toHaveText(/^\d[\d,]*$/);
  await expect(page.getByTestId("tile-median-cycle").locator("dd").first()).toHaveText(/\d|—/);
  await shipped.getByRole("link", { name: "Throughput report" }).click();
  await expect(page).toHaveURL("/reports/throughput?range=today");
  await page.goBack();
  await page.getByRole("link", { name: "Cycle time report" }).click();
  await expect(page).toHaveURL("/reports/cycle-time");
});
