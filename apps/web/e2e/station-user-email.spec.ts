import { expect, test } from "@playwright/test";
import { hashPin, stationOnlyPlaceholder } from "@woolrus/core";
import { createDb } from "@woolrus/db";
import { followMagicLink, signInAs } from "./support/auth";
import { findUserRow } from "./support/users";

// SPEC-identity amendment 1, success criterion 21: an admin adds an email to a station-only user,
// who then signs in personally by magic link as the same user, keeping their PIN.

const db = createDb();
// See users.spec.ts: /users renders slowly on a local database full of e2e users.
const slowRender = { timeout: 30_000 };

test("desktop: an admin adds an email to a station user, who then signs in as themselves", async ({
  page,
  browser,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "one viewport is enough for a dialog");
  test.slow();
  const name = `Email Luis ${crypto.randomUUID().slice(0, 8)}`;
  const pinHash = await hashPin("482916");
  const luis = await db.user.create({
    data: { name, email: stationOnlyPlaceholder(), roles: ["PACKER"], pinHash },
  });
  const email = `luis-${crypto.randomUUID()}@example.test`;
  await signInAs(page, ["ADMIN"]);

  await page.goto("/users");
  const row = await findUserRow(page, name);
  await expect(row.getByText("Station only")).toBeVisible();
  await row.getByRole("button", { name: `Actions for ${name}` }).click(slowRender);
  await page.getByRole("menuitem", { name: "Add email" }).click();
  const dialog = page.getByRole("dialog", { name: `Add an email for ${name}` });

  // A typo in the confirmation is caught before anything is sent.
  await dialog.getByLabel("Email", { exact: true }).fill(email);
  await dialog.getByLabel("Confirm email").fill(`x${email}`);
  await dialog.getByRole("button", { name: "Add email" }).click();
  await expect(dialog.getByText("The two addresses don't match.")).toBeVisible();
  expect((await db.user.findUniqueOrThrow({ where: { id: luis.id } })).email).not.toBe(email);

  await dialog.getByLabel("Confirm email").fill(email);
  await dialog.getByRole("button", { name: "Add email" }).click();
  await expect(page.getByText(`${name} can now sign in with ${email}.`)).toBeVisible(slowRender);
  await expect(row).toContainText(email);
  await expect(row.getByText("Station only")).toHaveCount(0);

  // Same row: id, roles and PIN kept.
  expect(await db.user.findUniqueOrThrow({ where: { id: luis.id } })).toMatchObject({
    email,
    roles: ["PACKER"],
    pinHash,
  });

  // Luis follows a magic link to the new address and is signed in as the same user.
  const luisPage = await (await browser.newContext()).newPage();
  await followMagicLink(luisPage, email);
  await expect(luisPage).toHaveURL(/\/boxes$/);
  const session = await db.session.findFirstOrThrow({
    where: { user: { email } },
    orderBy: { createdAt: "desc" },
  });
  expect(session.userId).toBe(luis.id);
  expect((await db.user.findUniqueOrThrow({ where: { id: luis.id } })).emailVerified).toBe(true);
});
