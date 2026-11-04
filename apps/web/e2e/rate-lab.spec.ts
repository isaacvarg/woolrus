import { expect, type Page, test } from "@playwright/test";
import { createFakeShippingProvider, runLabRun } from "@woolrus/core";
import { createDb } from "@woolrus/db";
import { signInAs, signInAsUser } from "./support/auth";
import { openNav } from "./support/nav";
import { demoService } from "./support/qa";
import { ensureShipFrom } from "./support/rates";
import { withSettingsLock } from "./support/settings-lock";
import { findUserRow } from "./support/users";

// Rate Lab (SPEC-rate-lab), against the fake ShipStation (SHIPPING_PROVIDERS=fake), whose address
// check abbreviates "Street". Provider accounts are global, so the journey takes its turn through
// withSettingsLock and leaves ShipStation off and without credentials, as carriers.spec.ts expects.

const db = createDb();
const prefix = `E2E lab ${crypto.randomUUID().slice(0, 8)}`;
const api = "/api/v1/shipping";

test.afterAll(async () => {
  await db.rateLabAddress.deleteMany({ where: { title: { startsWith: prefix } } });
  await db.rateLabParcel.deleteMany({ where: { title: { startsWith: prefix } } });
  await db.rateLabGroup.deleteMany({ where: { name: { startsWith: prefix } } });
  await db.product.deleteMany({ where: { name: { startsWith: prefix } } });
  await db.box.deleteMany({ where: { name: { startsWith: prefix } } });
});

const desktopOnly = (projectName: string) =>
  test.skip(projectName !== "desktop", "Rate Lab users are on desktops (assumption 5)");

async function ok(response: Promise<{ ok(): boolean; status(): number; url(): string }>) {
  const r = await response;
  expect(r.ok(), `${r.status()} ${r.url()}`).toBe(true);
}

async function rateLabLink(page: Page) {
  await page.goto("/");
  await openNav(page);
  return page.getByRole("link", { name: "Rate Lab" });
}

test("only Admins and the Rate Lab role open Rate Lab", async ({ browser }, info) => {
  desktopOnly(info.project.name);
  for (const roles of [["SHIPPER"], ["QA"]] as const) {
    const page = await (await browser.newContext()).newPage();
    await signInAs(page, [...roles]);
    await expect(await rateLabLink(page)).toHaveCount(0);
    await page.goto("/rate-lab/addresses");
    await expect(page.getByText("You don't have permission to do that.")).toBeVisible();
    await page.context().close();
  }

  const picker = await (await browser.newContext()).newPage();
  await signInAs(picker, ["PICKER", "RATE_LAB"]);
  await (await rateLabLink(picker)).click();
  await expect(picker).toHaveURL("/rate-lab/runs");
  const tabs = picker.getByRole("navigation", { name: "Rate Lab sections" });
  await expect(tabs.getByRole("link")).toHaveText([
    "Runs",
    "Addresses",
    "Parcels",
    "Quote",
    "Trends",
  ]);
  await picker.goto("/rate-lab/real-orders");
  await expect(picker.getByText("You don't have permission to do that.")).toBeVisible();
  await picker.context().close();
});

test("an admin gives a user Rate Lab; they add an address, see it corrected, tag and archive it", async ({
  page,
  browser,
}, info) => {
  desktopOnly(info.project.name);
  test.setTimeout(120_000);
  await signInAs(page, ["ADMIN"]);
  const name = `${prefix} user`;
  const user = await db.user.create({
    data: { name, email: `e2e-${crypto.randomUUID()}@example.test`, emailVerified: true },
  });
  const lab = await (await browser.newContext()).newPage();

  try {
    // The admin ticks Rate Lab on the user's roles.
    await page.goto("/users");
    const row = await findUserRow(page, name);
    await row.getByRole("button", { name: `Actions for ${name}` }).click();
    await page.getByRole("menuitem", { name: "Edit roles" }).click();
    const roles = page.getByRole("dialog", { name: `Roles for ${name}` });
    await roles.getByText("Rate Lab").click();
    await roles.getByRole("button", { name: "Save" }).click();
    await expect(roles).toBeHidden({ timeout: 30_000 });
    await expect(row).toContainText("Rate Lab", { timeout: 30_000 });

    await withSettingsLock(async () => {
      try {
        await ok(
          page.request.put(`${api}/providers/SHIPSTATION/credentials`, {
            data: { credentials: { apiKey: "e2e-rate-lab" } },
          }),
        );
        await ok(
          page.request.post(`${api}/providers/SHIPSTATION/enabled`, { data: { enabled: true } }),
        );

        await signInAsUser(lab, user.id);
        await (await rateLabLink(lab)).click();
        await lab
          .getByRole("navigation", { name: "Rate Lab sections" })
          .getByRole("link", { name: "Addresses" })
          .click();

        // A group to tag it with.
        await lab.getByRole("button", { name: "Manage groups" }).click();
        const groups = lab.getByRole("dialog", { name: "Address groups" });
        await groups.getByLabel("Group name").fill(`${prefix} West`);
        await groups.getByRole("button", { name: "Add group" }).click();
        await expect(groups.getByText(`${prefix} West`)).toBeVisible();
        await groups.getByRole("button", { name: "Close" }).click();

        await lab.getByRole("button", { name: "Add address" }).click();
        const add = lab.getByRole("dialog", { name: "Add address" });
        await add.getByLabel("Title").fill(`${prefix} Ranch`);
        await add.getByLabel("Recipient name").fill("Ranch house");
        await add.getByLabel("Address line 1").fill("12 Prairie Street");
        await add.getByLabel("City").fill("Jordan");
        await add.getByLabel("State or province").fill("MT");
        await add.getByLabel("Postal code").fill("59337");
        await add.getByText(`${prefix} West`).click();
        await add.getByRole("button", { name: "Save" }).click();

        // The dialog stays open on the check: typed vs. corrected.
        const edit = lab.getByRole("dialog", { name: "Edit address" });
        const shipTo = edit.getByTestId("ship-to");
        await expect(shipTo).toContainText("Corrected");
        await expect(shipTo.getByTestId("ship-to-original")).toContainText("12 Prairie Street");
        await expect(shipTo.getByTestId("ship-to-corrected")).toContainText("12 Prairie St ·");
        await edit.getByRole("button", { name: "Close" }).click();

        const address = lab.getByRole("row", { name: new RegExp(`${prefix} Ranch`) });
        await expect(address).toContainText("12 Prairie St");
        await expect(address).toContainText("Residential");
        await expect(address).toContainText(`${prefix} West`);

        await address.getByRole("button", { name: "Archive" }).click();
        await expect(address).toBeHidden();
        await lab.getByText("Show archived").click();
        await expect(address).toContainText("Archived");
      } finally {
        await page.request.delete(`${api}/providers/SHIPSTATION/credentials`);
      }
    });
  } finally {
    await lab.context().close();
  }
});

test("a Rate Lab user adds a parcel from a box with contents and one with a typed size, in a group", async ({
  page,
}, info) => {
  desktopOnly(info.project.name);
  test.setTimeout(90_000);
  const box = await db.box.create({
    data: { name: `${prefix} Medium`, lengthIn: 12, widthIn: 10, heightIn: 8 },
  });
  const wooProductId = 1_000_000_000 + Math.floor(Math.random() * 1_000_000_000);
  await db.product.create({
    data: {
      wooProductId,
      type: "simple",
      name: `${prefix} Glass jar candle`,
      rawPayload: {},
      syncedAt: new Date(),
    },
  });

  await signInAs(page, ["PACKER", "RATE_LAB"]);
  await page.goto("/rate-lab/parcels");

  await page.getByRole("button", { name: "Manage groups" }).click();
  const groups = page.getByRole("dialog", { name: "Parcel groups" });
  await groups.getByLabel("Group name").fill(`${prefix} Fragile`);
  await groups.getByRole("button", { name: "Add group" }).click();
  await expect(groups.getByText(`${prefix} Fragile`)).toBeVisible();
  await groups.getByRole("button", { name: "Close" }).click();

  // From a box: its inner size is copied; the contents are for customs.
  await page.getByRole("button", { name: "Add parcel" }).click();
  const fromBox = page.getByRole("dialog", { name: "Add parcel" });
  await fromBox.getByLabel("Title").fill(`${prefix} Medium jar`);
  await fromBox.getByLabel("What it tests").fill("Dimensional weight on the Medium box");
  await fromBox.getByRole("button", { name: /Box/ }).click();
  await page.getByRole("option", { name: `${prefix} Medium` }).click();
  await expect(fromBox.getByTestId("lab-parcel-box-size")).toContainText("12 × 10 × 8");
  await fromBox.getByLabel("Weight (lb)").fill("3");
  await fromBox.getByLabel("Find a product").fill(`${prefix} Glass`);
  await fromBox.getByRole("button", { name: `Add ${prefix} Glass jar candle` }).click();
  await expect(fromBox.getByLabel(`Quantity of ${prefix} Glass jar candle`)).toHaveValue("1");
  await fromBox.getByText(`${prefix} Fragile`).click();
  await fromBox.getByRole("button", { name: "Save" }).click();
  await expect(fromBox).toBeHidden();

  const jar = page.getByRole("row", { name: new RegExp(`${prefix} Medium jar`) });
  await expect(jar).toContainText(`${prefix} Medium`);
  await expect(jar).toContainText("12 × 10 × 8");
  await expect(jar).toContainText(`1 × ${prefix} Glass jar candle`);
  await expect(jar).toContainText(`${prefix} Fragile`);

  // A typed size, in the same group.
  await page.getByRole("button", { name: "Add parcel" }).click();
  const typed = page.getByRole("dialog", { name: "Add parcel" });
  await typed.getByLabel("Title").fill(`${prefix} Poly mailer`);
  await typed.getByText("Typed size").click();
  await typed.getByLabel("Length (in)").fill("10");
  await typed.getByLabel("Width (in)").fill("13");
  await typed.getByLabel("Height (in)").fill("1");
  await typed.getByLabel("Weight (lb)").fill("0");
  await typed.getByLabel("Weight (oz)").fill("6");
  await typed.getByText(`${prefix} Fragile`).click();
  await typed.getByRole("button", { name: "Save" }).click();
  await expect(typed).toBeHidden();

  const mailer = page.getByRole("row", { name: new RegExp(`${prefix} Poly mailer`) });
  await expect(mailer).toContainText("10 × 13 × 1");
  await expect(mailer).toContainText("None");

  // The group filter finds both.
  await page.getByRole("button", { name: /Group/ }).click();
  await page.getByRole("option", { name: `${prefix} Fragile` }).click();
  await expect(page.getByTestId("lab-parcel-row")).toHaveCount(2);

  // A later box edit doesn't change the parcel.
  await db.box.update({ where: { id: box.id }, data: { lengthIn: 14 } });
  await page.reload();
  await expect(jar).toContainText("12 × 10 × 8");
});

test("a Rate Lab user starts a run on the fakes, sees progress and sees it finish", async ({
  page,
}, info) => {
  desktopOnly(info.project.name);
  test.setTimeout(120_000);
  const value = (title: string) => ({
    name: title,
    address1: "1 Main St",
    city: "Denver",
    state: "CO",
    postalCode: "80202",
    country: "US",
  });
  const addressGroup = await db.rateLabGroup.create({
    data: { kind: "ADDRESS", name: `${prefix} Run addresses` },
  });
  const parcelGroup = await db.rateLabGroup.create({
    data: { kind: "PARCEL", name: `${prefix} Run parcels` },
  });
  for (const title of [`${prefix} Run A`, `${prefix} Run B`]) {
    await db.rateLabAddress.create({
      data: {
        title,
        original: value(title),
        address: value(title),
        residential: true,
        checkStatus: "VERIFIED",
        groups: { create: { groupId: addressGroup.id } },
      },
    });
  }
  await db.rateLabParcel.create({
    data: {
      title: `${prefix} Run parcel`,
      lengthIn: 10,
      widthIn: 8,
      heightIn: 4,
      weightOz: 20,
      groups: { create: { groupId: parcelGroup.id } },
    },
  });
  const runIds: string[] = [];

  await withSettingsLock(async () => {
    await ensureShipFrom();
    const { carrier, service, created } = await demoService();
    const before = await db.shippingProviderAccount.findUnique({
      where: { provider: "SHIPSTATION" },
    });
    await db.shippingCarrier.update({ where: { id: carrier.id }, data: { enabled: true } });
    await db.carrierService.update({ where: { id: service.id }, data: { enabled: true } });
    const admin = await (await page.context().browser()?.newContext())?.newPage();
    if (!admin) throw new Error("no browser");
    try {
      await signInAs(admin, ["ADMIN"]);
      await ok(
        admin.request.put(`${api}/providers/SHIPSTATION/credentials`, {
          data: { credentials: { apiKey: "e2e-rate-lab" } },
        }),
      );
      await ok(
        admin.request.post(`${api}/providers/SHIPSTATION/enabled`, { data: { enabled: true } }),
      );

      await signInAs(page, ["QA", "RATE_LAB"]);
      await page.goto("/rate-lab/runs");
      await page.getByRole("button", { name: "New run" }).click();
      const dialog = page.getByRole("dialog", { name: "New run" });
      await dialog.getByText(`${prefix} Run addresses`).click();
      await dialog.getByText(`${prefix} Run parcels`).click();
      await expect(dialog.getByTestId("lab-run-count")).toHaveText(
        "2 addresses × 1 parcel = 2 combinations",
      );
      await dialog.getByRole("button", { name: "Start run" }).click();
      await expect(dialog).toBeHidden();

      const row = page.getByTestId("lab-run-row").first();
      await expect(row).toContainText("Queued");
      await expect(row).toContainText(`${prefix} Run addresses`);
      const run = await db.rateLabRun.findFirstOrThrow({
        where: { kind: "SUITE", status: "QUEUED" },
        orderBy: { createdAt: "desc" },
      });
      runIds.push(run.id);

      // CI starts no worker: the job runs here, against a slow fake so its progress shows.
      const job = runLabRun(db, [createFakeShippingProvider("SHIPSTATION", { latencyMs: 6_000 })], {
        runId: run.id,
      });
      await expect(row).toContainText("Running", { timeout: 15_000 });
      await expect(row.getByRole("progressbar", { name: "Combinations quoted" })).toBeVisible();
      expect(await job).toEqual({ status: "SUCCEEDED" });
      await expect(row).toContainText("Succeeded", { timeout: 15_000 });
      await expect(row).toContainText("Fake");
    } finally {
      await db.$executeRaw`DELETE FROM pgboss.job WHERE name = 'rateLab.run'
        AND data->>'runId' = ANY(${runIds})`;
      await db.rateLabRun.deleteMany({ where: { id: { in: runIds } } });
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
});

test("an admin lowers the run cap; a Rate Lab user is held to it, then cancels a running run", async ({
  page,
}, info) => {
  desktopOnly(info.project.name);
  test.setTimeout(150_000);
  const value = (title: string) => ({
    name: title,
    address1: "1 Main St",
    city: "Denver",
    state: "CO",
    postalCode: "80202",
    country: "US",
  });
  const addressGroup = await db.rateLabGroup.create({
    data: { kind: "ADDRESS", name: `${prefix} Cancel addresses` },
  });
  const parcelGroup = await db.rateLabGroup.create({
    data: { kind: "PARCEL", name: `${prefix} Cancel parcels` },
  });
  for (const letter of ["A", "B", "C", "D"]) {
    const title = `${prefix} Cancel ${letter}`;
    await db.rateLabAddress.create({
      data: {
        title,
        original: value(title),
        address: value(title),
        residential: true,
        checkStatus: "VERIFIED",
        groups: { create: { groupId: addressGroup.id } },
      },
    });
  }
  await db.rateLabParcel.create({
    data: {
      title: `${prefix} Cancel parcel`,
      lengthIn: 10,
      widthIn: 8,
      heightIn: 4,
      weightOz: 20,
      groups: { create: { groupId: parcelGroup.id } },
    },
  });
  const runIds: string[] = [];

  await withSettingsLock(async () => {
    await ensureShipFrom();
    const { carrier, service, created } = await demoService();
    const before = await db.shippingProviderAccount.findUnique({
      where: { provider: "SHIPSTATION" },
    });
    const capBefore = (await db.settings.findFirstOrThrow()).rateLabMaxCombinations;
    await db.shippingCarrier.update({ where: { id: carrier.id }, data: { enabled: true } });
    await db.carrierService.update({ where: { id: service.id }, data: { enabled: true } });
    const admin = await (await page.context().browser()?.newContext())?.newPage();
    if (!admin) throw new Error("no browser");
    try {
      await signInAs(admin, ["ADMIN"]);
      await ok(
        admin.request.put(`${api}/providers/SHIPSTATION/credentials`, {
          data: { credentials: { apiKey: "e2e-rate-lab" } },
        }),
      );
      await ok(
        admin.request.post(`${api}/providers/SHIPSTATION/enabled`, { data: { enabled: true } }),
      );
      const setCap = async (cap: number) => {
        await admin.goto("/settings/shipping");
        const card = admin.getByRole("region", { name: "Rate Lab" });
        await card.getByLabel("Combination cap").fill(String(cap));
        await card.getByRole("button", { name: "Save" }).click();
        await expect(admin.getByText("Rate Lab cap saved.")).toBeVisible();
      };
      await setCap(3);

      await signInAs(page, ["QA", "RATE_LAB"]);
      await page.goto("/rate-lab/runs");
      const dialog = page.getByRole("dialog", { name: "New run" });
      const pick = async () => {
        await page.getByRole("button", { name: "New run" }).click();
        await dialog.getByText(`${prefix} Cancel addresses`).click();
        await dialog.getByText(`${prefix} Cancel parcels`).click();
        await expect(dialog.getByTestId("lab-run-count")).toContainText(
          "4 addresses × 1 parcel = 4 combinations",
        );
      };
      await pick();
      await expect(dialog).toContainText("That's over the cap of 3 combinations set in Settings.");
      await expect(dialog.getByRole("button", { name: "Start run" })).toBeDisabled();
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

      await setCap(4);
      await pick();
      await expect(dialog).not.toContainText("over the cap");
      await dialog.getByRole("button", { name: "Start run" }).click();
      await expect(dialog).toBeHidden();
      const run = await db.rateLabRun.findFirstOrThrow({
        where: { kind: "SUITE", status: "QUEUED" },
        orderBy: { createdAt: "desc" },
      });
      runIds.push(run.id);

      // CI starts no worker: the job runs here. Three of the four combinations are quoted at once,
      // slowly, so the cancel lands while they're going and the fourth never starts.
      const job = runLabRun(db, [createFakeShippingProvider("SHIPSTATION", { latencyMs: 6_000 })], {
        runId: run.id,
      });
      const row = page.getByTestId("lab-run-row").first();
      await expect(row).toContainText("Running", { timeout: 15_000 });
      await row.getByRole("button", { name: /^Cancel the run started/ }).click();
      await expect(page.getByText("Run cancelled.")).toBeVisible();
      await expect(row).toContainText("Stopping after the combinations in progress.");
      expect(await job).toEqual({ status: "CANCELLED" });
      await expect(row).toContainText("Cancelled", { timeout: 15_000 });
      await expect(row.getByRole("button", { name: /^Cancel the run started/ })).toHaveCount(0);
      const done = await db.rateLabRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(done.completedCombinations).toBe(3);
      expect(await db.rateFetch.count({ where: { labRunId: run.id } })).toBe(3);
    } finally {
      await db.settings.updateMany({ data: { rateLabMaxCombinations: capBefore } });
      await db.$executeRaw`DELETE FROM pgboss.job WHERE name = 'rateLab.run'
        AND data->>'runId' = ANY(${runIds})`;
      await db.rateLabRun.deleteMany({ where: { id: { in: runIds } } });
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
});

test("a Rate Lab user quotes a typed address against a saved and a typed parcel, then saves the address", async ({
  page,
}, info) => {
  desktopOnly(info.project.name);
  test.setTimeout(120_000);
  await db.rateLabParcel.create({
    data: { title: `${prefix} Quote parcel`, lengthIn: 10, widthIn: 8, heightIn: 4, weightOz: 20 },
  });
  const startedAt = new Date();

  await withSettingsLock(async () => {
    await ensureShipFrom();
    const { carrier, service, created } = await demoService();
    const before = await db.shippingProviderAccount.findUnique({
      where: { provider: "SHIPSTATION" },
    });
    await db.shippingCarrier.update({ where: { id: carrier.id }, data: { enabled: true } });
    await db.carrierService.update({ where: { id: service.id }, data: { enabled: true } });
    const admin = await (await page.context().browser()?.newContext())?.newPage();
    if (!admin) throw new Error("no browser");
    try {
      await signInAs(admin, ["ADMIN"]);
      await ok(
        admin.request.put(`${api}/providers/SHIPSTATION/credentials`, {
          data: { credentials: { apiKey: "e2e-rate-lab" } },
        }),
      );
      await ok(
        admin.request.post(`${api}/providers/SHIPSTATION/enabled`, { data: { enabled: true } }),
      );

      await signInAs(page, ["QA", "RATE_LAB"]);
      await page.goto("/rate-lab/quote");
      const form = page.getByRole("form", { name: "One-off quote" });
      await form.getByLabel("Recipient name").fill("Pat Buyer");
      await form.getByLabel("Address line 1").fill("12 Prairie Street");
      await form.getByLabel("City").fill("Jordan");
      await form.getByLabel("State or province").fill("MT");
      await form.getByLabel("Postal code").fill("59337");
      await form.getByText(`${prefix} Quote parcel`).click();
      await form.getByRole("button", { name: "Add parcel" }).click();
      const typed = form.getByTestId("typed-parcel");
      await typed.getByText("Typed size").click();
      await typed.getByLabel("Length (in)").fill("9");
      await typed.getByLabel("Width (in)").fill("6");
      await typed.getByLabel("Height (in)").fill("3");
      await typed.getByLabel("Weight (lb)").fill("0");
      await typed.getByLabel("Weight (oz)").fill("12");
      await form.getByRole("button", { name: "Get quotes" }).click();

      const results = page.getByRole("region", { name: "Quotes" });
      await expect(results.getByTestId("ship-to")).toContainText("Corrected", { timeout: 30_000 });
      const cards = results.getByTestId("parcel-quotes");
      await expect(cards).toHaveCount(2);
      await expect(cards.nth(0)).toContainText(`${prefix} Quote parcel`);
      await expect(cards.nth(1)).toContainText("Typed parcel 1");
      for (const card of [cards.nth(0), cards.nth(1)]) {
        await expect(card.getByRole("table")).toBeVisible();
        await expect(card.getByRole("row")).not.toHaveCount(1);
        await expect(card).toContainText("Cheapest");
      }

      await results.getByRole("button", { name: "Save as test address" }).click();
      const save = page.getByRole("dialog", { name: "Save as test address" });
      await save.getByLabel("Title").fill(`${prefix} Quoted ranch`);
      await save.getByRole("button", { name: "Save" }).click();
      await expect(results.getByText(`Saved as “${prefix} Quoted ranch”.`)).toBeVisible();

      const address = await db.rateLabAddress.findFirstOrThrow({
        where: { title: `${prefix} Quoted ranch` },
      });
      expect(address.lockedAt).toBeNull();
      expect(address.original).toMatchObject({ address1: "12 Prairie Street" });
      expect(address.address).toMatchObject({ address1: "12 Prairie St" });
    } finally {
      // The one-off's fetches point at the saved parcel, so the run (and its fetches) go first.
      await db.rateLabRun.deleteMany({ where: { kind: "ONE_OFF", createdAt: { gte: startedAt } } });
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
});
