import { expect, test } from "@playwright/test";
import { hashPin } from "@woolrus/core";
import { createDb } from "@woolrus/db";
import { followMagicLink, signInAs } from "./support/auth";
import { chooseTile, openNav } from "./support/stations";

// The identity module's two journeys (SPEC-identity success criteria 13 and 14), one per device:
// the desktop admin flow and the tablet floor flow. Details are in users, invitations,
// credentials and stations specs; these prove the pieces hold together.

const db = createDb();
// See users.spec.ts: /users renders slowly on a local database full of e2e users.
const slowRender = { timeout: 30_000 };
const unique = () => crypto.randomUUID().slice(0, 8);

test("desktop: an invited user signs in with their role's nav, and deactivation bounces them", async ({
  page,
  browser,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the desktop journey");
  test.slow();
  await signInAs(page, ["ADMIN"]);
  const email = `journey-${crypto.randomUUID()}@example.test`;

  // The admin invites a packer.
  await page.goto("/users?tab=invitations");
  await page.getByRole("button", { name: "Invite user" }).click(slowRender);
  const invite = page.getByRole("dialog");
  await invite.getByLabel("Email").fill(email);
  await invite.getByText("Packer").click();
  await invite.getByRole("button", { name: "Send invitation" }).click();
  await expect(page.getByText(`Invitation sent to ${email}.`)).toBeVisible(slowRender);

  // The invitee follows the logged magic link and sees only what a Packer may.
  const invitee = await (await browser.newContext()).newPage();
  await invitee.clock.install();
  await followMagicLink(invitee, email);
  await expect(invitee).toHaveURL(/\/boxes$/);
  const nav = invitee.getByRole("navigation");
  await expect(nav.getByRole("link", { name: "Boxes" })).toBeVisible();
  for (const adminOnly of ["Users", "Stations", "Settings", "Sync"]) {
    await expect(nav.getByRole("link", { name: adminOnly, exact: true })).toHaveCount(0);
  }

  // The admin deactivates them.
  await page.goto("/users");
  const row = page.getByRole("row").filter({ hasText: email });
  await row.getByRole("button", { name: /^Actions for/ }).click(slowRender);
  await page.getByRole("menuitem", { name: "Deactivate" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Deactivate" }).click();
  await expect(row).toContainText("Deactivated", slowRender);

  // Their open page bounces to sign-in on its next refresh, with no navigation of theirs.
  await invitee.clock.fastForward("01:05");
  await expect(invitee).toHaveURL(/\/sign-in$/, slowRender);
});

test("tablet: badge, station, PIN unlock, badge switch, and idle lock", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "tablet", "the tablet floor journey");
  test.slow();
  await page.clock.install();
  await signInAs(page, ["ADMIN"]);
  const pin = "482916";
  const packer = await db.user.create({
    data: {
      name: `Journey Packer ${unique()}`,
      email: `e2e-${crypto.randomUUID()}@example.test`,
      roles: ["PACKER"],
      pinHash: await hashPin(pin),
    },
  });
  const picker = await db.user.create({
    data: {
      name: `Journey Picker ${unique()}`,
      email: `e2e-${crypto.randomUUID()}@example.test`,
      roles: ["PICKER"],
    },
  });

  // The admin issues the picker a badge; the print view has the QR code and the text code.
  await page.goto("/users");
  const row = page.getByRole("row").filter({ hasText: picker.name });
  await row.getByRole("button", { name: `Actions for ${picker.name}` }).click(slowRender);
  await page.getByRole("menuitem", { name: "Issue badge" }).click();
  const badge = page.getByRole("dialog", { name: `Badge for ${picker.name}` });
  await expect(
    badge.getByRole("img", { name: `Badge QR code for ${picker.name}` }).locator("svg"),
  ).toBeVisible(slowRender);
  const code = (await badge.getByText(/^WRB-[0-9A-Z]{20}$/).textContent()) ?? "";
  await badge.getByRole("button", { name: "Close" }).click();

  // The admin makes this tablet a station: the lock screen shows.
  const stationName = `Journey Pack ${unique()}`;
  await page.goto("/stations");
  await page.getByRole("button", { name: "Make this device a station" }).click(slowRender);
  await page.getByRole("dialog").getByLabel("Name").fill(stationName);
  await page.getByRole("dialog").getByRole("button", { name: "Make it a station" }).click();
  await expect(page).toHaveURL(/\/station$/);
  await expect(page.getByRole("heading", { name: stationName })).toBeVisible();

  // The packer unlocks with their PIN.
  await chooseTile(page, packer.name);
  await page.getByLabel(`PIN for ${packer.name}`).fill(pin);
  await expect(page).toHaveURL(/\/boxes$/);
  await openNav(page);
  await expect(page.getByText(`Station: ${stationName}`)).toBeVisible();
  await expect(page.getByText(packer.name)).toBeVisible();

  // The picker switches in by scanning their badge (a HID scanner types it, then Enter).
  await page.getByRole("link", { name: "Switch user" }).click();
  await expect(page.getByLabel("Badge")).toBeFocused();
  await page.keyboard.type(`${code}\n`);
  await expect(page).toHaveURL(/\/boxes$/);
  await openNav(page);
  await expect(page.getByText(picker.name)).toBeVisible();

  // No input past the idle limit: the lock screen returns, and the server agrees.
  const station = await db.station.findUniqueOrThrow({ where: { name: stationName } });
  await db.stationActivation.updateMany({
    where: { stationId: station.id, endedAt: null },
    data: { lastActivityAt: new Date(Date.now() - 11 * 60_000) },
  });
  await page.clock.fastForward("11:00");
  await expect(page).toHaveURL(/\/station$/);
  await expect(page.getByText("Locked", { exact: true })).toBeVisible();
  expect(
    await db.stationActivation.findFirst({ where: { stationId: station.id, userId: picker.id } }),
  ).toMatchObject({ endReason: "IDLE" });
});
