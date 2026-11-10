import { expect, test } from "@playwright/test";
import { createDb } from "@woolrus/db";
import { signInAs } from "./support/auth";
import { createOrder, deleteCreatedOrders } from "./support/orders";
import { chooseTile } from "./support/stations";
import { findUserRow } from "./support/users";

// SPEC-identity amendment 1, success criterion 20: a station-only user, added by an admin with a
// generated PIN, unlocks a station the admin just registered and picks as themselves there.

const db = createDb();
// See users.spec.ts: /users renders slowly on a local database full of e2e users.
const slowRender = { timeout: 30_000 };
const unique = () => crypto.randomUUID().slice(0, 8);

test.afterAll(deleteCreatedOrders);

test("tablet: an admin adds a station user who unlocks with the generated PIN and picks", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "tablet", "the tablet floor journey");
  test.slow();
  const customerName = `E2E ${crypto.randomUUID()}`;
  const order = await createOrder({ customerName, quantity: 1 });
  await signInAs(page, ["ADMIN"]);
  const name = `Station Luis ${unique()}`;

  // Add station user: name, Picker (Admin isn't offered), and a generated PIN.
  await page.goto("/users");
  await page.getByRole("button", { name: "Add station user" }).click(slowRender);
  const add = page.getByRole("dialog", { name: "Add station user" });
  await expect(add.getByRole("checkbox", { name: "Admin" })).toHaveCount(0);
  await add.getByLabel("Name").fill(name);
  await add.getByText("Picker", { exact: true }).click();
  await add.getByRole("button", { name: "Generate" }).click();
  const pin = (await add.getByRole("status").locator("strong").textContent()) ?? "";
  expect(pin).toMatch(/^\d{6}$/);
  await expect(add.getByLabel("New PIN")).toHaveValue(pin);
  await add.getByRole("button", { name: "Add", exact: true }).click();

  // Created: the dialog offers Issue badge, which opens the print view for them.
  await expect(add.getByText(`${name} can now unlock any station with their PIN.`)).toBeVisible();
  await add.getByRole("button", { name: "Issue badge" }).click();
  const badge = page.getByRole("dialog", { name: `Badge for ${name}` });
  await expect(badge.getByText(/^WRB-[0-9A-Z]{20}$/)).toBeVisible(slowRender);
  await badge.getByRole("button", { name: "Close" }).click();

  // Their row says Station only, never the placeholder, and Edit roles leaves out Admin.
  const row = await findUserRow(page, name);
  await expect(row.getByText("Station only")).toBeVisible();
  await expect(row).not.toContainText("station.invalid");
  await row.getByRole("button", { name: `Actions for ${name}` }).click(slowRender);
  await page.getByRole("menuitem", { name: "Edit roles" }).click();
  const roles = page.getByRole("dialog", { name: `Roles for ${name}` });
  await expect(roles.getByRole("checkbox", { name: "Picker" })).toBeChecked();
  await expect(roles.getByRole("checkbox", { name: "Admin" })).toHaveCount(0);
  await roles.getByRole("button", { name: "Cancel" }).click();

  // The admin makes this tablet a station: the new user's tile is on the lock screen.
  const stationName = `Station Users ${unique()}`;
  await page.goto("/stations");
  await page.getByRole("button", { name: "Make this device a station" }).click(slowRender);
  await page.getByRole("dialog").getByLabel("Name").fill(stationName);
  await page.getByRole("dialog").getByRole("button", { name: "Make it a station" }).click();
  await expect(page).toHaveURL(/\/station$/);
  await expect(page.getByRole("heading", { name: stationName })).toBeVisible();
  const station = await db.station.findUniqueOrThrow({ where: { name: stationName } });
  const user = await db.user.findFirstOrThrow({ where: { name } });

  // They unlock with the PIN, and the station acts as them, with no email to show.
  await chooseTile(page, name);
  await page.getByLabel(`PIN for ${name}`).fill(pin);
  await expect(page).not.toHaveURL(/\/station$/);
  expect(await (await page.request.get("/api/v1/me")).json()).toMatchObject({
    id: user.id,
    email: null,
    roles: ["PICKER"],
    stationId: station.id,
  });

  // Their pick records them and the station.
  await page.goto("/queue/pending");
  await page.getByRole("searchbox", { name: "Search orders" }).fill(customerName);
  await page
    .getByRole("row", { name: new RegExp(order.number) })
    .getByRole("button", { name: "Begin Picking" })
    .click();
  await expect(page).toHaveURL(`/pick/${order.id}`);
  const picked = page.waitForResponse(/\/rpc\/picking\/pickLine/);
  await page
    .getByTestId("pick-card")
    .first()
    .getByRole("button", { name: /^E2E item/, pressed: false })
    .click();
  await picked;

  expect(
    await db.orderStageEvent.findFirst({ where: { orderId: order.id, toStatus: "PICKING" } }),
  ).toMatchObject({ actorId: user.id, stationId: station.id });
  expect(
    await db.auditEvent.findFirst({ where: { action: "pick.pickLine", actorId: user.id } }),
  ).toMatchObject({ stationId: station.id });
});

// Success criterion 22 and decision 13: a taken name warns, ignoring case and surrounding spaces,
// but never blocks. A deactivated user's name doesn't count.
test("desktop: adding a station user with a taken name warns but still adds them", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "one viewport is enough for a dialog");
  const id = unique();
  const taken = `Dup Luis ${id}`;
  const gone = `Gone Luis ${id}`;
  await db.user.createMany({
    data: [
      { name: taken, email: `e2e-${crypto.randomUUID()}@example.test`, roles: ["PICKER"] },
      {
        name: gone,
        email: `e2e-${crypto.randomUUID()}@example.test`,
        roles: ["PICKER"],
        active: false,
      },
    ],
  });
  await signInAs(page, ["ADMIN"]);
  await page.goto("/users");
  await page.getByRole("button", { name: "Add station user" }).click(slowRender);
  const add = page.getByRole("dialog", { name: "Add station user" });
  const warning = add.getByText(/An active user is already called/);

  // A deactivated user's name: no warning.
  const checked = page.waitForResponse(
    (response) =>
      response.url().includes("/rpc/users/list") && !!response.request().postData()?.includes(gone),
  );
  await add.getByLabel("Name").fill(gone);
  await checked;
  await expect(warning).toHaveCount(0);

  // An active user's name in another case, with spaces: the warning shows.
  await add.getByLabel("Name").fill(`  ${taken.toLowerCase()} `);
  await expect(warning).toBeVisible();
  await expect(warning).toContainText(taken);

  // The admin can still add them.
  await add.getByText("Picker", { exact: true }).click();
  await add.getByRole("button", { name: "Generate" }).click();
  await add.getByRole("button", { name: "Add", exact: true }).click();
  await expect(add.getByText("can now unlock any station with their PIN.")).toBeVisible();
  expect(await db.user.count({ where: { name: { equals: taken, mode: "insensitive" } } })).toBe(2);
});

// "Everything else is unchanged" (SPEC-identity amendment 1): clearing the PIN of a station-only
// user with no badge leaves them no way in, so it asks first, but it's still allowed.
test("desktop: clearing a badge-less station user's PIN warns first, then clears it", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "one viewport is enough for a dialog");
  const name = `No Badge Luis ${unique()}`;
  const user = await db.user.create({
    data: {
      name,
      email: `${crypto.randomUUID()}@station.invalid`,
      roles: ["PICKER"],
      pinHash: "not-a-real-hash",
    },
  });
  await signInAs(page, ["ADMIN"]);
  await page.goto("/users");
  const row = await findUserRow(page, name);
  const clearPin = async () => {
    await row.getByRole("button", { name: `Actions for ${name}` }).click(slowRender);
    await page.getByRole("menuitem", { name: "Clear PIN" }).click();
  };
  const confirm = page.getByRole("dialog", { name: `Clear ${name}'s PIN?` });

  // Cancel keeps the PIN.
  await clearPin();
  await expect(confirm.getByText("can't unlock any station")).toBeVisible();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toHaveCount(0);
  expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).pinHash).not.toBeNull();

  // Confirming clears it.
  await clearPin();
  await confirm.getByRole("button", { name: "Clear PIN" }).click();
  await expect(page.getByText(`PIN cleared for ${name}.`)).toBeVisible();
  expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).pinHash).toBeNull();
});

// The same for the badge: revoking it from a station-only user with no PIN asks first.
test("desktop: revoking a PIN-less station user's badge warns first, then revokes it", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "one viewport is enough for a dialog");
  const name = `No PIN Luis ${unique()}`;
  const user = await db.user.create({
    data: {
      name,
      email: `${crypto.randomUUID()}@station.invalid`,
      roles: ["PICKER"],
      badgeCode: `e2e-${crypto.randomUUID()}`,
    },
  });
  await signInAs(page, ["ADMIN"]);
  await page.goto("/users");
  const row = await findUserRow(page, name);
  await row.getByRole("button", { name: `Actions for ${name}` }).click(slowRender);
  await page.getByRole("menuitem", { name: "Revoke badge" }).click();
  const confirm = page.getByRole("dialog", { name: `Revoke ${name}'s badge?` });
  await expect(confirm.getByText("can't unlock any station")).toBeVisible();
  await confirm.getByRole("button", { name: "Revoke badge" }).click();
  await expect(page.getByText(`Badge revoked for ${name}.`)).toBeVisible();
  expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).badgeCode).toBeNull();
});
