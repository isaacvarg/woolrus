import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { createDb } from "@woolrus/db";
import { signInAs, signInAsUser } from "./support/auth";
import { openNav } from "./support/nav";
import { createOrder, deleteCreatedOrders } from "./support/orders";
import { findUserRow } from "./support/users";

// The Reports role and the Reports area (SPEC-reporting, ticket #210): who reaches /reports, the
// shared date range in the URL, and the Spend tab's link to Rate Lab → Real orders.

const db = createDb();
test.afterAll(deleteCreatedOrders);
const forbidden = "You don't have permission to do that.";

const desktopOnly = (projectName: string) =>
  test.skip(projectName !== "desktop", 'Reports are desktop first (SPEC-reporting "UI")');

async function navLink(page: Page, name: string) {
  await page.goto("/");
  await openNav(page);
  return page.getByRole("link", { name, exact: true });
}

const tabs = (page: Page) => page.getByRole("navigation", { name: "Report sections" });
const day = (page: Page, name: "From" | "To") => page.getByRole("textbox", { name, exact: true });

/** Types a day into the range; typing before hydration is lost, so it types again until the URL has it. */
async function setDay(page: Page, name: "From" | "To", value: string) {
  const key = name === "From" ? "from" : "to";
  await expect(async () => {
    await day(page, name).fill(value);
    expect(new URL(page.url()).searchParams.get(key)).toBe(value);
  }).toPass({ timeout: 30_000 });
}

test("an admin ticks the Reports role; a Packer with it reaches Reports and Real orders only", async ({
  page,
  browser,
}, info) => {
  desktopOnly(info.project.name);
  test.setTimeout(90_000);
  await signInAs(page, ["ADMIN"]);
  const name = `E2E reports ${crypto.randomUUID().slice(0, 8)}`;
  const user = await db.user.create({
    data: {
      name,
      email: `e2e-${crypto.randomUUID()}@example.test`,
      emailVerified: true,
      roles: ["PACKER"],
    },
  });

  await page.goto("/users");
  const row = await findUserRow(page, name);
  await row.getByRole("button", { name: `Actions for ${name}` }).click();
  await page.getByRole("menuitem", { name: "Edit roles" }).click();
  const roles = page.getByRole("dialog", { name: `Roles for ${name}` });
  await roles.getByText("Reports", { exact: true }).click();
  await roles.getByRole("button", { name: "Save" }).click();
  await expect(roles).toBeHidden({ timeout: 30_000 });
  await expect(row).toContainText("Reports", { timeout: 30_000 });

  const lead = await (await browser.newContext()).newPage();
  try {
    await signInAsUser(lead, user.id);
    await (await navLink(lead, "Reports")).click();
    await expect(lead).toHaveURL("/reports/throughput");
    await expect(tabs(lead).getByRole("link")).toHaveText([
      "Throughput",
      "Cycle time",
      "Quality",
      "Spend",
    ]);
    await expect(lead.getByRole("heading", { name: "Orders imported and shipped" })).toBeVisible();

    // Under Rate Lab they get Real orders and nothing of the lab itself.
    await lead.goto("/rate-lab");
    await expect(lead).toHaveURL("/rate-lab/real-orders");
    await expect(
      lead.getByRole("navigation", { name: "Rate Lab sections" }).getByRole("link"),
    ).toHaveText(["Real orders"]);
    await lead.goto("/rate-lab/runs");
    await expect(lead.getByText(forbidden)).toBeVisible();

    // Still no settings or user admin.
    await expect(await navLink(lead, "Users")).toHaveCount(0);
    await expect(lead.getByRole("link", { name: "Settings", exact: true })).toHaveCount(0);
    for (const path of ["/users", "/settings"]) {
      await lead.goto(path);
      await expect(lead.getByText(forbidden)).toBeVisible();
    }
  } finally {
    await lead.context().close();
  }
});

test("without report.read there is no Reports item and /reports refuses", async ({
  browser,
}, info) => {
  desktopOnly(info.project.name);
  for (const roles of [["PACKER"], ["RATE_LAB"]] as const) {
    const page = await (await browser.newContext()).newPage();
    await signInAs(page, [...roles]);
    await expect(await navLink(page, "Reports")).toHaveCount(0);
    await page.goto("/reports/throughput");
    await expect(page.getByText(forbidden)).toBeVisible();
    await expect(tabs(page)).toHaveCount(0);
    await page.context().close();
  }
});

test("the range lives in the URL, survives a reload, and Spend opens Real orders on it", async ({
  page,
}, info) => {
  desktopOnly(info.project.name);
  await signInAs(page, ["PICKER", "REPORTS"]);
  await page.goto("/reports");
  await expect(page).toHaveURL("/reports/throughput");
  const picker = page.getByRole("button", { name: /Date range/ });
  await expect(picker).toContainText("Last 7 days");

  await picker.click();
  await page.getByRole("option", { name: "Last 30 days" }).click();
  await expect(page).toHaveURL("/reports/throughput?range=30d");
  await page.reload();
  await expect(page.getByRole("button", { name: /Date range/ })).toContainText("Last 30 days");

  // A custom range is written by its days; the tabs carry it along.
  await page.goto("/reports/quality?range=custom&from=2026-10-01&to=2026-10-31");
  await expect(day(page, "From")).toHaveValue("2026-10-01");
  await setDay(page, "To", "2026-10-15");
  await expect(page).toHaveURL("/reports/quality?range=custom&from=2026-10-01&to=2026-10-15");
  await page.reload();
  await expect(day(page, "To")).toHaveValue("2026-10-15");

  // More than 92 days is refused in the header.
  await setDay(page, "From", "2026-01-01");
  await expect(page.getByText("Pick a range of at most 92 days.")).toBeVisible();
  await setDay(page, "From", "2026-10-01");

  await tabs(page).getByRole("link", { name: "Spend" }).click();
  await expect(page).toHaveURL("/reports/spend?range=custom&from=2026-10-01&to=2026-10-15");
  await page.getByRole("link", { name: "Open Real orders for these dates" }).click();
  await expect(page).toHaveURL("/rate-lab/real-orders?from=2026-10-01&to=2026-10-15");
  await expect(day(page, "From")).toHaveValue("2026-10-01");
  await expect(day(page, "To")).toHaveValue("2026-10-15");
});

test("Throughput shows a person's orders and units for the day, filtered, and exports them", async ({
  page,
}, info) => {
  desktopOnly(info.project.name);
  const name = `E2E picker ${crypto.randomUUID().slice(0, 8)}`;
  const picker = await db.user.create({
    data: { name, email: `e2e-${crypto.randomUUID()}@example.test`, roles: ["PICKER"] },
  });
  const order = await createOrder({ quantity: 4, status: "PACKING" });
  const now = new Date();
  await db.orderItem.updateMany({
    where: { orderId: order.id },
    data: { pickedById: picker.id, pickedAt: now, pickedQuantity: 4, pickStatus: "PICKED" },
  });
  await db.orderStageEvent.create({
    data: {
      orderId: order.id,
      fromStatus: "PICKING",
      toStatus: "PACKING",
      actorId: picker.id,
      at: now,
    },
  });

  await signInAs(page, ["PACKER", "REPORTS"]);
  // Today, in the browser's zone; other tests' work shares the dev database, so filter to the picker.
  await page.goto(`/reports/throughput?range=today&person=${picker.id}`);
  const byPerson = page.getByTestId("throughput-by-person");
  await expect(byPerson.getByRole("row")).toHaveCount(2);
  await expect(byPerson.getByRole("row").nth(1)).toHaveText(
    new RegExp(`${name}\\s*Picking\\s*1\\s*4\\s*1`),
  );
  await expect(page.getByRole("button", { name: /Person/ })).toContainText(name);

  // The Packing stage filter leaves nothing of theirs.
  await page.getByRole("button", { name: /Stage/ }).click();
  await page.getByRole("option", { name: "Packing" }).click();
  await expect(page).toHaveURL(/stage=PACKING/);
  await expect(
    page.getByText("No picks, packs, QA checks or shipments in these days."),
  ).toBeVisible();
  await page.getByRole("button", { name: /Stage/ }).click();
  await page.getByRole("option", { name: "Picking" }).click();
  await expect(byPerson.getByRole("row")).toHaveCount(2);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "Export CSV" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(
    /^woolrus-throughput-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv$/,
  );
  const lines = (await readFile(await download.path()))
    .toString("utf8")
    .replace(/^﻿/, "")
    .trimEnd()
    .split("\r\n");
  expect(lines[0]).toBe("Day,Stage,Person,Orders,Units");
  expect(lines.slice(1)).toEqual([
    expect.stringMatching(new RegExp(`^\\d{4}-\\d{2}-\\d{2},PICKING,${name},1,4$`)),
  ]);
});
