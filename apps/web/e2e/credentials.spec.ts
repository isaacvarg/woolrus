import { expect, test } from "@playwright/test";
import { createDb } from "@woolrus/db";
import { signInAs } from "./support/auth";
import { findUserRow } from "./support/users";

const db = createDb();
// See users.spec.ts: /users renders slowly on a local database full of e2e users.
const slowRender = { timeout: 30_000 };

async function packer() {
  const name = `E2E ${crypto.randomUUID().slice(0, 8)}`;
  const user = await db.user.create({
    data: { name, email: `e2e-${crypto.randomUUID()}@example.test`, roles: ["PACKER"] },
  });
  return user;
}

test("an admin sets a generated PIN, issues a badge to print, and revokes it", async ({ page }) => {
  test.slow();
  await signInAs(page, ["ADMIN"]);
  const user = await packer();
  await page.goto("/users");
  const row = await findUserRow(page, user.name);
  const actions = row.getByRole("button", { name: `Actions for ${user.name}` });

  // PIN: Generate shows it once, then it saves.
  await actions.click(slowRender);
  await page.getByRole("menuitem", { name: "Set PIN" }).click();
  const pinDialog = page.getByRole("dialog", { name: `PIN for ${user.name}` });
  await pinDialog.getByRole("button", { name: "Generate" }).click();
  const pin = await pinDialog.getByLabel("New PIN").inputValue();
  expect(pin).toMatch(/^\d{6}$/);
  await expect(pinDialog.getByRole("status")).toContainText(pin);
  await pinDialog.getByRole("button", { name: "Save" }).click();
  await expect(pinDialog).toBeHidden(slowRender);
  expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).pinHash).toMatch(
    /^scrypt\$/,
  );

  // Badge: the print view has the name, a QR code and the code as text.
  await actions.click();
  await page.getByRole("menuitem", { name: "Issue badge" }).click();
  const badge = page.getByRole("dialog", { name: `Badge for ${user.name}` });
  const qr = badge.getByRole("img", { name: `Badge QR code for ${user.name}` });
  await expect(qr.locator("svg")).toBeVisible(slowRender);
  const code = await badge.getByText(/^WRB-[0-9A-Z]{20}$/).textContent();
  const stored = await db.user.findUniqueOrThrow({ where: { id: user.id } });
  expect(stored.badgeCode).toMatch(/^[0-9a-f]{64}$/);
  expect(stored.badgeCode).not.toBe(code);
  await badge.getByRole("button", { name: "Close" }).click();
  await expect(row).toContainText("Yes", slowRender);

  await actions.click();
  await page.getByRole("menuitem", { name: "Revoke badge" }).click();
  await expect(page.getByText(`Badge revoked for ${user.name}.`)).toBeVisible(slowRender);
  expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).badgeCode).toBeNull();
});

test("a weak PIN is refused with a translated field error", async ({ page }) => {
  test.slow();
  await signInAs(page, ["ADMIN"]);
  const user = await packer();
  await page.goto("/users");
  const row = await findUserRow(page, user.name);
  await row.getByRole("button", { name: `Actions for ${user.name}` }).click(slowRender);
  await page.getByRole("menuitem", { name: "Set PIN" }).click();
  const dialog = page.getByRole("dialog", { name: `PIN for ${user.name}` });
  await dialog.getByLabel("New PIN").fill("123456");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByText("Too easy to guess", { exact: false })).toBeVisible(slowRender);
});

test("PIN and badge procedures are admin-only", async ({ page }) => {
  await signInAs(page, ["PACKER"]);
  const user = await packer();
  const calls = [
    page.request.put(`/api/v1/users/${user.id}/pin`, { data: { pin: "482915" } }),
    page.request.delete(`/api/v1/users/${user.id}/pin`),
    page.request.post(`/api/v1/users/${user.id}/badge`),
    page.request.delete(`/api/v1/users/${user.id}/badge`),
  ];
  for (const response of await Promise.all(calls)) expect(response.status()).toBe(403);
});
