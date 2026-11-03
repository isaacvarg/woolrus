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
  await db.rateLabGroup.deleteMany({ where: { name: { startsWith: prefix } } });
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
