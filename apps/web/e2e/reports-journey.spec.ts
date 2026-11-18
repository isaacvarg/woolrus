import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { createDb } from "@woolrus/db";
import { seedReportingHistory } from "@woolrus/db/demo-reporting";
import { signInAs } from "./support/auth";
import { openNav } from "./support/nav";
import { createOrder, deleteCreatedOrders } from "./support/orders";
import { withSettingsLock } from "./support/settings-lock";

// The reporting journey on the dev seed's history (SPEC-reporting criterion 9, ticket #218): an
// admin walks every Reports tab over the last 30 days, checks a figure the seed fixes, and takes
// a CSV; a packer sees the SLA alert but no Reports item.

const db = createDb();
test.afterAll(deleteCreatedOrders);

const desktopOnly = (projectName: string) =>
  test.skip(projectName !== "desktop", 'Reports are desktop first (SPEC-reporting "UI")');

/** The first of the last 30 days (the "Last 30 days" preset), at local midnight. */
function thirtyDaysAgo(): Date {
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - 29);
  return since;
}

async function download(page: Page, link: string) {
  const [file] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: link }).click(),
  ]);
  const lines = (await readFile(await file.path()))
    .toString("utf8")
    .replace(/^﻿/, "")
    .trimEnd()
    .split("\r\n");
  return { name: file.suggestedFilename(), lines };
}

test("an admin walks the Reports tabs over the seeded month and exports cycle times", async ({
  page,
}, info) => {
  desktopOnly(info.project.name);
  test.setTimeout(120_000);
  // `pnpm db:seed` adds this history; CI's database starts empty, so make sure it's there.
  await seedReportingHistory(db);

  // Maria Packer only exists in the seeded history, so her figures are the seed's alone.
  const maria = await db.user.findUniqueOrThrow({ where: { email: "demo-packer-2@example.test" } });
  const since = thirtyDaysAgo();
  const packed = await db.orderStageEvent.count({
    where: { actorId: maria.id, fromStatus: "PACKING", toStatus: "QA", at: { gte: since } },
  });
  const units = await db.packageItem.aggregate({
    where: { packedById: maria.id, packedAt: { gte: since } },
    _sum: { quantity: true },
  });
  expect(packed).toBeGreaterThan(0);

  await signInAs(page, ["ADMIN"]);
  await page.goto(`/reports/throughput?person=${maria.id}`);
  await page.getByRole("button", { name: /Date range/ }).click();
  await page.getByRole("option", { name: "Last 30 days" }).click();
  await expect(page).toHaveURL(/range=30d/);
  const byPerson = page.getByTestId("throughput-by-person");
  await expect(byPerson.getByRole("row")).toHaveCount(2);
  await expect(byPerson.getByRole("row").nth(1)).toHaveText(
    new RegExp(`Maria Packer\\s*Packing\\s*${packed}\\s*${units._sum.quantity}\\s*\\d+`),
  );

  const tabs = page.getByRole("navigation", { name: "Report sections" });
  await tabs.getByRole("link", { name: "Cycle time" }).click();
  await expect(page).toHaveURL(/\/reports\/cycle-time\?.*range=30d/);
  const shipped = await db.order.findMany({
    where: { wooOrderId: { gt: 9_100_000 }, completedAt: { gte: since } },
    select: { number: true },
    orderBy: { completedAt: "asc" },
  });
  const summary = page.getByRole("region", { name: "Cycle time summary" });
  await expect(summary).toContainText("Orders shipped");
  const count = Number(
    (await summary.locator(".stat-value").first().innerText()).replace(/\D/g, ""),
  );
  expect(count).toBeGreaterThanOrEqual(shipped.length);
  await expect(page.getByRole("heading", { name: /slowest/i })).toBeVisible();

  const csv = await download(page, "Export CSV");
  expect(csv.name).toMatch(/^woolrus-cycle-time-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv$/);
  expect(csv.lines[0]).toMatch(/^Order,Imported,/);
  const numbers = new Set(csv.lines.slice(1).map((line) => line.split(",")[0]));
  for (const { number } of shipped) expect(numbers, number).toContain(number);

  await tabs.getByRole("link", { name: "Quality" }).click();
  await expect(page).toHaveURL(/\/reports\/quality\?.*range=30d/);
  // She packed well over 100 units, so she has a rate, and the seed's scans include unknown barcodes.
  await expect(
    page.getByTestId("quality-rates").getByRole("row").filter({ hasText: "Maria Packer" }),
  ).not.toHaveCount(0);
  await expect(
    page.getByTestId("quality-scans").getByRole("columnheader", { name: "Unknown barcode" }),
  ).toBeVisible();
  await expect(page.getByTestId("quality-voids").getByRole("row")).not.toHaveCount(1);

  await tabs.getByRole("link", { name: "Spend" }).click();
  await expect(page.getByRole("link", { name: "Open Real orders for these dates" })).toBeVisible();
});

test("a packer sees the SLA alert on the dashboard but no Reports item", async ({ page }, info) => {
  desktopOnly(info.project.name);
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
      const alert = page.getByRole("status", { name: "Orders past their stage's time limit" });
      await expect(alert.getByRole("link", { name: /^\d+ in Packing$/ })).toBeVisible();
    } finally {
      await db.settings.update({
        where: { id: 1 },
        data: { stageSlaMinutes: before?.stageSlaMinutes ?? {} },
      });
    }
  });
  await openNav(page);
  await expect(page.getByRole("link", { name: "Reports", exact: true })).toHaveCount(0);
});
