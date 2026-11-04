import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { createFakeShippingProvider, runLabRun } from "@woolrus/core";
import { createDb } from "@woolrus/db";
import { signInAs } from "./support/auth";
import { openNav } from "./support/nav";
import { demoService } from "./support/qa";
import { ensureShipFrom } from "./support/rates";
import { withSettingsLock } from "./support/settings-lock";

// Rate Lab's whole journey (SPEC-rate-lab success criterion 17) on the fake ShipStation: an admin
// sets up the suite, a Rate Lab user runs it, reads it, exports it, quotes one-off and sees Trends.
// Provider accounts are global, so it takes its turn through withSettingsLock and leaves
// ShipStation as it found it.

const db = createDb();
const prefix = `E2E journey ${crypto.randomUUID().slice(0, 8)}`;
const api = "/api/v1/shipping";
const runIds: string[] = [];
const startedAt = new Date();

test.afterAll(async () => {
  await db.$executeRaw`DELETE FROM pgboss.job WHERE name = 'rateLab.run'
    AND data->>'runId' = ANY(${runIds})`;
  // Runs (and their fetches) first: fetches hold on to the addresses and parcels.
  await db.rateLabRun.deleteMany({ where: { id: { in: runIds } } });
  await db.rateLabRun.deleteMany({ where: { kind: "ONE_OFF", createdAt: { gte: startedAt } } });
  await db.rateLabAddress.deleteMany({ where: { title: { startsWith: prefix } } });
  await db.rateLabParcel.deleteMany({ where: { title: { startsWith: prefix } } });
  await db.rateLabGroup.deleteMany({ where: { name: { startsWith: prefix } } });
});

async function ok(response: Promise<{ ok(): boolean; status(): number; url(): string }>) {
  const r = await response;
  expect(r.ok(), `${r.status()} ${r.url()}`).toBe(true);
}

async function addGroup(page: Page, dialogName: string, name: string) {
  await page.getByRole("button", { name: "Manage groups" }).click();
  const groups = page.getByRole("dialog", { name: dialogName });
  await groups.getByLabel("Group name").fill(name);
  await groups.getByRole("button", { name: "Add group" }).click();
  await expect(groups.getByText(name)).toBeVisible();
  await groups.getByRole("button", { name: "Close" }).click();
}

async function addAddress(page: Page, group: string, title: string, street: string, zip: string) {
  await page.getByRole("button", { name: "Add address" }).click();
  const add = page.getByRole("dialog", { name: "Add address" });
  await add.getByLabel("Title").fill(title);
  await add.getByLabel("Recipient name").fill(title);
  await add.getByLabel("Address line 1").fill(street);
  await add.getByLabel("City").fill("Denver");
  await add.getByLabel("State or province").fill("CO");
  await add.getByLabel("Postal code").fill(zip);
  await add.getByText(group).click();
  await add.getByRole("button", { name: "Save" }).click();
  // The dialog stays open on the check.
  const edit = page.getByRole("dialog", { name: "Edit address" });
  await expect(edit.getByTestId("ship-to")).toBeVisible({ timeout: 30_000 });
  await edit.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("row", { name: new RegExp(title) })).toContainText(group);
}

async function addParcel(page: Page, group: string, title: string, size: string[], oz: string) {
  await page.getByRole("button", { name: "Add parcel" }).click();
  const add = page.getByRole("dialog", { name: "Add parcel" });
  await add.getByLabel("Title").fill(title);
  await add.getByText("Typed size").click();
  const [length = "", width = "", height = ""] = size;
  await add.getByLabel("Length (in)").fill(length);
  await add.getByLabel("Width (in)").fill(width);
  await add.getByLabel("Height (in)").fill(height);
  await add.getByLabel("Weight (lb)").fill("0");
  await add.getByLabel("Weight (oz)").fill(oz);
  await add.getByText(group).click();
  await add.getByRole("button", { name: "Save" }).click();
  await expect(add).toBeHidden();
  await expect(page.getByRole("row", { name: new RegExp(title) })).toContainText(group);
}

test("Rate Lab end to end: set up, run, read, export, quote and trend; hidden without the role", async ({
  page,
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", "Rate Lab users are on desktops (assumption 5)");
  test.setTimeout(240_000);
  const addressGroup = `${prefix} Denver`;
  const parcelGroup = `${prefix} Boxes`;
  const addresses = [`${prefix} Home`, `${prefix} Office`];
  const parcels = [`${prefix} Small`, `${prefix} Large`];

  await withSettingsLock(async () => {
    await ensureShipFrom();
    const { carrier, service, created } = await demoService();
    const before = await db.shippingProviderAccount.findUnique({
      where: { provider: "SHIPSTATION" },
    });
    await db.shippingCarrier.update({ where: { id: carrier.id }, data: { enabled: true } });
    await db.carrierService.update({ where: { id: service.id }, data: { enabled: true } });
    const admin = await (await browser.newContext()).newPage();
    try {
      // 1. An admin adds two addresses and two parcels, each pair in a group.
      await signInAs(admin, ["ADMIN"]);
      await ok(
        admin.request.put(`${api}/providers/SHIPSTATION/credentials`, {
          data: { credentials: { apiKey: "e2e-rate-lab" } },
        }),
      );
      await ok(
        admin.request.post(`${api}/providers/SHIPSTATION/enabled`, { data: { enabled: true } }),
      );
      await admin.goto("/rate-lab/addresses");
      await addGroup(admin, "Address groups", addressGroup);
      await addAddress(admin, addressGroup, addresses[0] ?? "", "1 Main Street", "80202");
      await addAddress(admin, addressGroup, addresses[1] ?? "", "500 Market St", "80204");
      await admin.goto("/rate-lab/parcels");
      await addGroup(admin, "Parcel groups", parcelGroup);
      await addParcel(admin, parcelGroup, parcels[0] ?? "", ["8", "6", "4"], "12");
      await addParcel(admin, parcelGroup, parcels[1] ?? "", ["16", "12", "8"], "60");

      // 2. A Rate Lab user starts a run on both groups and watches it.
      await signInAs(page, ["PICKER", "RATE_LAB"]);
      await page.goto("/");
      await openNav(page);
      await page.getByRole("link", { name: "Rate Lab" }).click();
      await expect(page).toHaveURL("/rate-lab/runs");
      await page.getByRole("button", { name: "New run" }).click();
      const dialog = page.getByRole("dialog", { name: "New run" });
      await dialog.getByText(addressGroup).click();
      await dialog.getByText(parcelGroup).click();
      await expect(dialog.getByTestId("lab-run-count")).toHaveText(
        "2 addresses × 2 parcels = 4 combinations",
      );
      await dialog.getByRole("button", { name: "Start run" }).click();
      await expect(dialog).toBeHidden();

      const row = page.getByTestId("lab-run-row").filter({ hasText: addressGroup });
      await expect(row).toContainText("Queued");
      const run = await db.rateLabRun.findFirstOrThrow({
        where: { kind: "SUITE", status: "QUEUED" },
        orderBy: { createdAt: "desc" },
      });
      runIds.push(run.id);
      // CI starts no worker: the job runs here, against a slow fake so its progress shows.
      const job = runLabRun(db, [createFakeShippingProvider("SHIPSTATION", { latencyMs: 3_000 })], {
        runId: run.id,
      });
      await expect(row).toContainText("Running", { timeout: 15_000 });
      await expect(row.getByRole("progressbar", { name: "Combinations quoted" })).toBeVisible();
      expect(await job).toEqual({ status: "SUCCEEDED" });
      await expect(row).toContainText("Succeeded", { timeout: 15_000 });

      // The finished run, with its insights.
      await row.getByRole("link").first().click();
      await expect(page).toHaveURL(`/rate-lab/runs/${run.id}`);
      await expect(page.getByRole("heading", { name: /^Run of / })).toBeVisible();
      const picks = page.getByRole("table", { name: "Cheapest and fastest" });
      for (const address of addresses) {
        for (const parcel of parcels) {
          await expect(
            picks.getByRole("row").filter({ hasText: address }).filter({ hasText: parcel }),
          ).toContainText("Demo Ground");
        }
      }
      await expect(page.getByRole("table", { name: "Carrier wins" })).toContainText("Demo Ground");

      // 3. The CSV downloads; the PDF report page prints without the app's nav.
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.getByRole("link", { name: "Export CSV" }).click(),
      ]);
      expect(download.suggestedFilename()).toMatch(/^rate-lab-run-.*\.csv$/);
      const csv = await readFile((await download.path()) ?? "", "utf8");
      expect(csv.startsWith("﻿Run,Address,Parcel,Provider,")).toBe(true);
      for (const title of [...addresses, ...parcels]) expect(csv).toContain(title);

      const report = page.getByRole("link", { name: "PDF report" });
      await expect(report).toHaveAttribute("href", `/rate-lab/runs/${run.id}/report?print=1`);
      await page.setViewportSize({ width: 718, height: 1000 });
      await page.emulateMedia({ media: "print" });
      await page.goto(`/rate-lab/runs/${run.id}/report`);
      await expect(page.getByRole("heading", { name: "Rate Lab run report" })).toBeVisible();
      await expect(page.getByRole("table", { name: "Cheapest and fastest" })).toContainText(
        addresses[0] ?? "",
      );
      await expect(page.locator(".drawer-side")).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Rate Lab" })).toHaveCount(0);
      const overflow = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        width: document.documentElement.clientWidth,
      }));
      expect(overflow.scroll).toBeLessThanOrEqual(overflow.width);
      await page.emulateMedia({ media: "screen" });
      await page.setViewportSize({ width: 1280, height: 900 });

      // 4. A one-off quote against a saved parcel.
      await page.goto("/rate-lab/quote");
      const form = page.getByRole("form", { name: "One-off quote" });
      await form.getByLabel("Recipient name").fill("Pat Buyer");
      await form.getByLabel("Address line 1").fill("9 Oak Street");
      await form.getByLabel("City").fill("Boulder");
      await form.getByLabel("State or province").fill("CO");
      await form.getByLabel("Postal code").fill("80302");
      await form.getByText(parcels[0] ?? "").click();
      await form.getByRole("button", { name: "Get quotes" }).click();
      const results = page.getByRole("region", { name: "Quotes" });
      await expect(results.getByTestId("ship-to")).toContainText("Corrected", { timeout: 30_000 });
      const card = results.getByTestId("parcel-quotes");
      await expect(card).toHaveCount(1);
      await expect(card).toContainText(parcels[0] ?? "");
      await expect(card).toContainText("Cheapest");

      // 5. Trends: a cell per combination of the run (fake-quoted, so shown on request).
      await page
        .getByRole("navigation", { name: "Rate Lab sections" })
        .getByRole("link", { name: "Trends" })
        .click();
      await expect(page).toHaveURL("/rate-lab/trends");
      for (const name of [addressGroup, parcelGroup, "Include fake data"]) {
        const box = page.getByRole("checkbox", { name });
        await page.locator("label", { has: box }).click();
        await expect(box).toBeChecked();
      }
      const heatmap = page.getByRole("table", { name: "Cheapest price by address and parcel" });
      for (const parcel of parcels) {
        await expect(heatmap.getByRole("columnheader", { name: parcel })).toBeVisible();
      }
      await expect(heatmap.getByRole("row")).toHaveCount(3);
      for (const address of addresses) {
        const cells = heatmap.getByRole("row", { name: new RegExp(address) }).getByRole("cell");
        await expect(cells).toHaveCount(2);
        for (const cell of await cells.all()) await expect(cell).toContainText("$");
      }
    } finally {
      await admin.request.delete(`${api}/providers/SHIPSTATION/credentials`);
      await db.shippingProviderAccount.updateMany({
        where: { provider: "SHIPSTATION" },
        data: { enabled: before?.enabled ?? false },
      });
      if (created) {
        await db.carrierService.deleteMany({ where: { carrierId: carrier.id } });
        await db.shippingCarrier.deleteMany({ where: { id: carrier.id } });
      } else {
        await db.shippingCarrier.update({
          where: { id: carrier.id },
          data: { enabled: carrier.enabled },
        });
        await db.carrierService.update({
          where: { id: service.id },
          data: { enabled: service.enabled },
        });
      }
      await admin.context().close();
    }
  });

  // Without the role, Rate Lab isn't there.
  const shipper = await (await browser.newContext()).newPage();
  await signInAs(shipper, ["SHIPPER"]);
  await shipper.goto("/");
  await openNav(shipper);
  await expect(shipper.getByRole("link", { name: "Rate Lab" })).toHaveCount(0);
  await shipper.context().close();
});
