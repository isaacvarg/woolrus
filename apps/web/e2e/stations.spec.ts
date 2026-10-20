import { createHash, randomBytes } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { hashBadgeCode, hashPin } from "@woolrus/core";
import { createDb, type Role } from "@woolrus/db";
import { signInAs } from "./support/auth";
import { chooseTile, openNav } from "./support/stations";

const db = createDb();
const unique = () => crypto.randomUUID().slice(0, 8);

/** Makes `page`'s device a fresh station, as registering one would, without the admin dance. */
async function becomeStation(page: Page, baseURL: string | undefined) {
  const token = randomBytes(32).toString("base64url");
  const station = await db.station.create({
    data: {
      name: `E2E Station ${unique()}`,
      tokenHash: createHash("sha256").update(token).digest("hex"),
    },
  });
  await page
    .context()
    .addCookies([{ name: "woolrus_station", value: token, url: baseURL, httpOnly: true }]);
  return station;
}

/** A floor worker with a unique name, a PIN and a badge. */
async function worker(roles: Role[]) {
  const pin = "482916";
  const badge = `WRB-E2E${unique().toUpperCase()}`;
  const user = await db.user.create({
    data: {
      name: `E2E Worker ${unique()}`,
      email: `e2e-${crypto.randomUUID()}@example.test`,
      roles,
      pinHash: await hashPin(pin),
      badgeCode: hashBadgeCode(badge),
    },
  });
  return { ...user, pin, badge };
}

test("an admin makes this device a station, and revoking it sends the device to sign-in", async ({
  page,
  browser,
}) => {
  const admin = await signInAs(page, ["ADMIN"]);
  const name = `E2E Pack ${crypto.randomUUID().slice(0, 8)}`;

  await page.goto("/stations");
  await page.getByRole("button", { name: "Make this device a station" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByRole("button", { name: "Make it a station" }).click();

  // The lock screen, full screen, with the station's name.
  await expect(page).toHaveURL(/\/station$/);
  await expect(page.getByRole("heading", { name })).toBeVisible();

  // The token is only in an httpOnly cookie (StationSummary has no field for it; core tests check
  // the body), and the admin's own session on the device is over.
  const cookie = (await page.context().cookies()).find((c) => c.name === "woolrus_station");
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax" });
  expect(cookie?.expires).toBeGreaterThan(Date.now() / 1000 + 399 * 86_400);
  expect(await db.session.count({ where: { userId: admin.id } })).toBe(0);

  // Locked: app pages go to the lock screen and the API says so; the station itself answers.
  await page.goto("/boxes");
  await expect(page).toHaveURL(/\/station$/);
  const me = await page.request.get("/api/v1/me");
  expect(me.status()).toBe(401);
  expect(await me.json()).toMatchObject({ data: { messageKey: "errors.station.locked" } });
  const status = await page.request.get("/api/v1/station");
  expect(await status.json()).toMatchObject({ name });

  // Another admin, on a desktop, revokes it.
  const desk = await (await browser.newContext()).newPage();
  await signInAs(desk, ["ADMIN"]);
  await desk.goto("/stations");
  const row = desk.getByRole("row").filter({ hasText: name });
  await row.getByRole("button", { name: `Actions for ${name}` }).click();
  await desk.getByRole("menuitem", { name: "Revoke" }).click();
  await desk.getByRole("dialog").getByRole("button", { name: "Revoke" }).click();
  await expect(row).toContainText("Revoked");

  await page.goto("/boxes");
  await expect(page).toHaveURL(/\/sign-in$/);
  expect(
    (await page.context().cookies()).find((c) => c.name === "woolrus_station"),
  ).toBeUndefined();
});

test("an admin renames a station", async ({ page }) => {
  await signInAs(page, ["ADMIN"]);
  const station = await db.station.create({
    data: { name: `E2E Old ${crypto.randomUUID().slice(0, 8)}`, tokenHash: crypto.randomUUID() },
  });
  const renamed = `E2E New ${crypto.randomUUID().slice(0, 8)}`;

  await page.goto("/stations");
  const row = page.getByRole("row").filter({ hasText: station.name });
  await row.getByRole("button", { name: `Actions for ${station.name}` }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await page.getByRole("dialog").getByLabel("Name").fill(renamed);
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("row").filter({ hasText: renamed })).toBeVisible();
});

test("stations are admin-only", async ({ page, request }) => {
  await signInAs(page, ["PACKER"]);
  for (const response of await Promise.all([
    page.request.get("/api/v1/stations"),
    page.request.post("/api/v1/stations", { data: { name: "Nope" } }),
  ])) {
    expect(response.status()).toBe(403);
  }
  expect((await request.get("/api/v1/station")).status()).toBe(401);
});

test("a packer unlocks a station with a PIN, a picker switches in by badge, and Lock locks it", async ({
  page,
  baseURL,
}) => {
  const station = await becomeStation(page, baseURL);
  const packer = await worker(["PACKER"]);
  const picker = await worker(["PICKER"]);

  await page.goto("/station");
  await expect(page.getByRole("heading", { name: station.name })).toBeVisible();

  // A wrong PIN is refused; the right one unlocks and the station acts as the packer.
  await chooseTile(page, packer.name);
  await page.getByLabel(`PIN for ${packer.name}`).fill("000001");
  await expect(page.getByText("That PIN isn't right.")).toBeVisible();
  await page.getByLabel(`PIN for ${packer.name}`).fill(packer.pin);
  await expect(page).toHaveURL(/\/boxes$/);
  const asPacker = await (await page.request.get("/api/v1/me")).json();
  expect(asPacker).toMatchObject({
    id: packer.id,
    roles: ["PACKER"],
    stationId: station.id,
    stationName: station.name,
  });
  expect(asPacker.permissions).not.toContain("order.pick");

  // The nav names the station, and Lock replaces Log out.
  await openNav(page);
  await expect(page.getByText(`Station: ${station.name}`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Log out" })).toBeHidden();

  // Switch user: the lock screen, then a badge scan (a HID scanner types the code and Enter).
  await page.getByRole("link", { name: "Switch user" }).click();
  await expect(page.getByText(`${packer.name} is on this station.`)).toBeVisible();
  await expect(page.getByLabel("Badge")).toBeFocused();
  await page.keyboard.type(`${picker.badge.toLowerCase()}\n`);
  await expect(page).toHaveURL(/\/boxes$/);
  expect(await (await page.request.get("/api/v1/me")).json()).toMatchObject({
    id: picker.id,
    stationId: station.id,
  });
  expect(
    await db.stationActivation.findFirst({ where: { stationId: station.id, userId: packer.id } }),
  ).toMatchObject({ endReason: "SWITCHED_USER" });

  // Lock: back to the lock screen, and the API says the station is locked.
  await openNav(page);
  await page.getByRole("button", { name: "Lock" }).click();
  await expect(page).toHaveURL(/\/station$/);
  const me = await page.request.get("/api/v1/me");
  expect(me.status()).toBe(401);
  expect(await me.json()).toMatchObject({ data: { messageKey: "errors.station.locked" } });
});

test("input pushes the idle lock out, and the station locks itself at the deadline", async ({
  page,
  baseURL,
}) => {
  const station = await becomeStation(page, baseURL);
  const packer = await worker(["PACKER"]);
  await page.clock.install();

  await page.goto("/station");
  await chooseTile(page, packer.name);
  await page.getByLabel(`PIN for ${packer.name}`).fill(packer.pin);
  await expect(page).toHaveURL(/\/boxes$/);
  const me = await (await page.request.get("/api/v1/me")).json();
  expect(new Date(me.idleLockAt).getTime()).toBeGreaterThan(Date.now());

  // Input touches the station (at most once a minute); a read doesn't.
  const touched = page.waitForResponse((r) => r.url().includes("station/touch") && r.ok());
  await page.getByRole("heading").first().click();
  await touched;

  // The server: with the last input past the limit, the next request locks the station.
  await db.stationActivation.updateMany({
    where: { stationId: station.id, endedAt: null },
    data: { lastActivityAt: new Date(Date.now() - 11 * 60_000) },
  });
  const locked = await page.request.get("/api/v1/me");
  expect(await locked.json()).toMatchObject({ data: { messageKey: "errors.station.locked" } });
  expect(
    await db.stationActivation.findFirst({ where: { stationId: station.id, userId: packer.id } }),
  ).toMatchObject({ endReason: "IDLE" });

  // The client: at its deadline the lock screen shows on its own.
  await page.clock.fastForward("11:00");
  await expect(page).toHaveURL(/\/station$/);
  await expect(page.getByText("Locked", { exact: true })).toBeVisible();
});
