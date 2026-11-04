import { expect, type Page, test } from "@playwright/test";
import { createDb } from "@woolrus/db";
import { signInAs, signInAsUser } from "./support/auth";
import { openNav } from "./support/nav";
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
