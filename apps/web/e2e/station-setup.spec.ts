import { expect, test } from "@playwright/test";
import { createDb } from "@woolrus/db";
import { signInAs } from "./support/auth";

// SPEC-identity A3, station setup codes: an admin issues a code on their own device and a tablet
// redeems it without anyone signing in on it (criteria 29, 32, 33).

const db = createDb();
const unique = () => crypto.randomUUID().slice(0, 8);

/** `XXXXX-XXXXX` as someone might type it: lowercase, spaced, `O` for `0`. */
const sloppy = (code: string) => code.toLowerCase().replace("-", " ").replaceAll("0", "O");

test("an admin adds a station and a signed-out tablet redeems its code", async ({
  page,
  browser,
}) => {
  const admin = await signInAs(page, ["ADMIN"]);
  const name = `E2E Pack ${unique()}`;

  await page.goto("/stations");
  await page.getByRole("button", { name: "Add station" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByRole("button", { name: "Get a setup code" }).click();
  await expect(dialog.getByRole("heading", { name: `Set up ${name}` })).toBeVisible();
  await expect(
    dialog.getByRole("img", { name: `QR code of the setup link for ${name}` }),
  ).toBeVisible();
  const code = (await dialog.getByTestId("setup-code").textContent()) ?? "";
  expect(code).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);

  // The tablet: signed out, from the sign-in page.
  const tablet = await (await browser.newContext()).newPage();
  await tablet.goto("/sign-in");
  await tablet.getByRole("link", { name: "Set up this device as a station" }).click();
  await expect(tablet).toHaveURL(/\/station\/setup$/);
  await tablet.getByLabel("Setup code").fill(sloppy(code));
  await tablet.getByRole("button", { name: "Set up" }).click();

  await expect(tablet).toHaveURL(/\/station$/);
  await expect(tablet.getByRole("heading", { name })).toBeVisible();
  const cookie = (await tablet.context().cookies()).find((c) => c.name === "woolrus_station");
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax" });
  const status = await tablet.request.get("/api/v1/station");
  expect(await status.json()).toMatchObject({ name });
  const station = await db.station.findUniqueOrThrow({ where: { name } });
  expect(station.registeredById).toBe(admin.id);

  // A device that is a station never sees the setup page again.
  await tablet.goto("/station/setup");
  await expect(tablet).toHaveURL(/\/station$/);
});

test("opening the setup link only pre-fills the code; Set up redeems it", async ({
  page,
  browser,
}) => {
  await signInAs(page, ["ADMIN"]);
  const name = `E2E Pack ${unique()}`;
  const issue = await page.request.post("/api/v1/stations/setup-codes", { data: { name } });
  expect(issue.status()).toBe(200);
  const { id, code } = (await issue.json()) as { id: string; code: string };

  const tablet = await (await browser.newContext()).newPage();
  const response = await tablet.goto(`/station/setup?code=${code}`);
  expect(response?.headers()["referrer-policy"]).toBe("no-referrer");
  await expect(tablet.getByLabel("Setup code")).toHaveValue(code);
  // The code leaves the address bar once it's in the field.
  await expect(tablet).toHaveURL(/\/station\/setup$/);
  expect((await db.stationSetupCode.findUniqueOrThrow({ where: { id } })).usedAt).toBeNull();
  expect(await db.station.count({ where: { name } })).toBe(0);

  await tablet.getByRole("button", { name: "Set up" }).click();
  await expect(tablet.getByRole("heading", { name })).toBeVisible();
  expect((await db.stationSetupCode.findUniqueOrThrow({ where: { id } })).usedAt).not.toBeNull();
});

test("a wrong or used code says so in place and makes nothing", async ({ page, browser }) => {
  await signInAs(page, ["ADMIN"]);
  const name = `E2E Pack ${unique()}`;
  const { code } = (await (
    await page.request.post("/api/v1/stations/setup-codes", { data: { name } })
  ).json()) as { code: string };
  const first = await browser.newContext();
  const redeemed = await first.request.post("/api/v1/station/setup", { data: { code } });
  expect(redeemed.status()).toBe(200);
  // Never the token in the body; it's only in the cookie.
  const body = JSON.stringify(await redeemed.json());
  const token = (await first.cookies()).find((c) => c.name === "woolrus_station")?.value ?? "";
  expect(token).not.toBe("");
  expect(body).not.toContain(token);
  expect(body).not.toContain(code);

  const tablet = await (await browser.newContext()).newPage();
  await tablet.goto("/station/setup");
  for (const typed of [code, "7KQ4M-XD2RA"]) {
    await tablet.getByLabel("Setup code").fill(typed);
    await tablet.getByRole("button", { name: "Set up" }).click();
    await expect(
      tablet.getByText("That code doesn't work. Ask an admin for a new one."),
    ).toBeVisible();
    await expect(tablet).toHaveURL(/\/station\/setup$/);
  }
  expect(await db.station.count({ where: { name } })).toBe(1);
});

test("only an admin's personal session issues setup codes", async ({ page, request }) => {
  await signInAs(page, ["PACKER"]);
  const response = await page.request.post("/api/v1/stations/setup-codes", {
    data: { name: "Nope" },
  });
  expect(response.status()).toBe(403);
  expect(
    (await request.post("/api/v1/stations/setup-codes", { data: { name: "Nope" } })).status(),
  ).toBe(401);
});
