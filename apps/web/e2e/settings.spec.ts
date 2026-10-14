import { expect, type Page, test } from "@playwright/test";
import en from "@woolrus/i18n/messages/en.json" with { type: "json" };
import { signInAs } from "./support/auth";
import { withSettingsLock } from "./support/settings-lock";

/** On tablet width the nav is a drawer behind the menu button. */
async function openNav(page: Page) {
  const menu = page.getByLabel("Open menu");
  if (await menu.isVisible()) await menu.click();
}

// There is one settings row, and the desktop and tablet projects run in parallel. Tests that change
// it take turns through withSettingsLock and put back anything other tests could trip over.

test("an admin saves general settings and they persist after a reload", async ({ page }) => {
  await signInAs(page, ["ADMIN"]);
  await withSettingsLock(async () => {
    await page.goto("/settings");
    const general = page.getByRole("form", { name: "General" });
    const field = general.getByLabel("Sync interval", { exact: false });
    const next = Number(await field.inputValue()) === 7 ? 8 : 7;

    await field.fill(String(next));
    await general.getByRole("button", { name: "Save" }).click();
    await expect(general.getByRole("status")).toHaveText("Settings saved.");

    await page.reload();
    await expect(general.getByLabel("Sync interval", { exact: false })).toHaveValue(String(next));
  });
});

test("invalid input shows the field-level message next to the field", async ({ page }) => {
  await signInAs(page, ["ADMIN"]);
  await page.goto("/settings");
  const shipFrom = page.getByRole("group", { name: "Ship-from address" });

  await shipFrom.getByLabel("Contact name").fill("Shipping Dept");
  await shipFrom.getByLabel("Phone").fill("555-123-4567");
  await shipFrom.getByLabel("Address line 1").fill("1 Warehouse Way");
  await shipFrom.getByLabel("City").fill("Austin");
  await shipFrom.getByLabel("State").fill("Texas");
  await shipFrom.getByLabel("ZIP code").fill("78701");
  await page.getByRole("form", { name: "General" }).getByRole("button", { name: "Save" }).click();

  await expect(page.getByRole("alert").first()).toBeVisible();
  const state = shipFrom.getByRole("textbox", { name: "State" });
  await expect(state).toHaveAttribute("aria-invalid", "true");
  await expect(shipFrom.getByText("Use the 2-letter state code, e.g. TX.")).toBeVisible();
});

test("a Picker has no Settings link and is refused at /settings", async ({ page }) => {
  await signInAs(page, ["PICKER"]);
  await page.goto("/boxes");
  await openNav(page);
  await expect(page.getByRole("link", { name: "Boxes" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Settings" })).toHaveCount(0);

  await page.goto("/settings");
  await expect(page.getByText("You don't have permission to do that.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
});

test("an admin sees the Settings link", async ({ page }) => {
  await signInAs(page, ["ADMIN"]);
  await page.goto("/boxes");
  await openNav(page);
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
});

/** A secret's row on the settings page: its card, then the row named after the secret. */
function secretRow(page: Page, card: string, secret: string) {
  return page.getByRole("region", { name: card }).getByRole("group", { name: secret, exact: true });
}

test("replacing a secret marks it set without showing it, and clearing unsets it", async ({
  page,
}) => {
  // Not a secret the dev stack's Woo sync relies on.
  const value = `e2e-${crypto.randomUUID()}`;
  await signInAs(page, ["ADMIN"]);
  await withSettingsLock(async () => {
    try {
      await page.request.delete("/api/v1/settings/secrets/wooWebhookSecret");
      await page.goto("/settings");
      const row = secretRow(page, "WooCommerce", "Webhook secret");
      await expect(row.getByText("Not set", { exact: true })).toBeVisible();

      await row.getByRole("button", { name: "Add" }).click();
      await row.getByLabel("New value").fill(value);
      await row.getByRole("button", { name: "Save" }).click();
      await expect(row.getByText("Set", { exact: true })).toBeVisible();
      await expect(row.getByLabel("New value")).toHaveCount(0);

      await page.reload();
      await expect(row.getByText("Set", { exact: true })).toBeVisible();
      await row.getByRole("button", { name: "Replace" }).click();
      await expect(row.getByLabel("New value")).toHaveValue("");
      expect(await page.content()).not.toContain(value);
      await row.getByRole("button", { name: "Cancel" }).click();

      await row.getByRole("button", { name: "Clear" }).click();
      await row.getByRole("button", { name: "Yes, clear" }).click();
      await expect(row.getByText("Not set", { exact: true })).toBeVisible();
    } finally {
      await page.request.delete("/api/v1/settings/secrets/wooWebhookSecret");
    }
  });
});

test("a missing encryption key is explained in the user's language", async ({ page }) => {
  // The server half (setSecret refuses without a key) is covered by the core tests. The dev server
  // has a key, so the API's answer is stubbed here to check the UI translates it. Every secret write
  // is intercepted (RPC and REST), so a real one can never reach the shared dev database.
  let stubbed = 0;
  await page.route(/\/(rpc\/settings\/setSecret|api\/v1\/settings\/secrets\/)/, (route) => {
    stubbed += 1;
    return route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          defined: true,
          code: "BAD_REQUEST",
          status: 400,
          message: "Bad Request",
          data: { messageKey: "errors.settings.encryptionKeyMissing" },
        },
      }),
    });
  });
  await signInAs(page, ["ADMIN"]);
  await page.goto("/settings");
  const row = secretRow(page, "ShipStation", "API key");

  await row.getByRole("button", { name: /^(Add|Replace)$/ }).click();
  await row.getByLabel("New value").fill("anything");
  await row.getByRole("button", { name: "Save" }).click();
  await expect(row.getByRole("alert")).toHaveText(en.errors.settings.encryptionKeyMissing);
  expect(stubbed).toBe(1);
});

test("an http:// store URL shows the field message", async ({ page }) => {
  await signInAs(page, ["ADMIN"]);
  await withSettingsLock(async () => {
    // If validation ever regressed, this would save the URL; put back whatever was there.
    const before = (await (await page.request.get("/api/v1/settings")).json()).wooStoreUrl;
    try {
      await page.goto("/settings");
      const woo = page.getByRole("region", { name: "WooCommerce" });

      await woo.getByLabel("Store URL").fill("http://shop.example.com");
      await woo.getByRole("button", { name: "Save" }).click();
      await expect(woo.getByText(en.errors.field.urlHttps)).toBeVisible();
    } finally {
      await page.request.patch("/api/v1/settings", { data: { wooStoreUrl: before } });
    }
  });
});

test("an admin saves and removes the Lumexia base URL", async ({ page }) => {
  await signInAs(page, ["ADMIN"]);
  await withSettingsLock(async () => {
    try {
      await page.goto("/settings");
      const lumexia = page.getByRole("region", { name: "Lumexia" });

      await lumexia.getByLabel("API base URL").fill("https://lumexia.example.com");
      await lumexia.getByRole("button", { name: "Save" }).click();
      await expect(lumexia.getByRole("status")).toHaveText("Saved.");
      await page.reload();
      await expect(lumexia.getByLabel("API base URL")).toHaveValue("https://lumexia.example.com");

      await lumexia.getByLabel("API base URL").fill("");
      await lumexia.getByRole("button", { name: "Save" }).click();
      await expect(lumexia.getByRole("status")).toHaveText("Saved.");
      await page.reload();
      await expect(lumexia.getByLabel("API base URL")).toHaveValue("");
    } finally {
      await page.request.patch("/api/v1/settings", { data: { lumexiaBaseUrl: null } });
    }
  });
});

test("an admin saves the ship-from address and the Woo consumer secret, and both survive a reload", async ({
  page,
}) => {
  const secret = `e2e-${crypto.randomUUID()}`;
  await signInAs(page, ["ADMIN"]);
  await withSettingsLock(async () => {
    try {
      await page.goto("/settings");
      const general = page.getByRole("form", { name: "General" });
      const shipFrom = general.getByRole("group", { name: "Ship-from address" });
      await shipFrom.getByLabel("Contact name").fill("E2E Shipping");
      await shipFrom.getByLabel("Phone").fill("555-010-2030");
      await shipFrom.getByLabel("Address line 1").fill("100 Dock Street");
      await shipFrom.getByLabel("City").fill("Austin");
      await shipFrom.getByLabel("State").fill("TX");
      await shipFrom.getByLabel("ZIP code").fill("78702");
      await general.getByRole("button", { name: "Save" }).click();
      await expect(general.getByRole("status")).toHaveText("Settings saved.");

      const row = secretRow(page, "WooCommerce", "Consumer secret");
      await row.getByRole("button", { name: /^(Add|Replace)$/ }).click();
      await row.getByLabel("New value").fill(secret);
      await row.getByRole("button", { name: "Save" }).click();
      await expect(row.getByText("Set", { exact: true })).toBeVisible();

      await page.reload();
      await expect(shipFrom.getByLabel("Address line 1")).toHaveValue("100 Dock Street");
      await expect(shipFrom.getByLabel("ZIP code")).toHaveValue("78702");
      await expect(row.getByText("Set", { exact: true })).toBeVisible();
      await row.getByRole("button", { name: "Replace" }).click();
      await expect(row.getByLabel("New value")).toHaveValue("");
      expect(await page.content()).not.toContain(secret);
    } finally {
      // The dev stack's Woo sync falls back on .env only while this secret is unset.
      await page.request.delete("/api/v1/settings/secrets/wooConsumerSecret");
    }
  });
});

test("switching weight display to decimal pounds changes the boxes page", async ({ page }) => {
  await signInAs(page, ["ADMIN"]);
  const created = await page.request.post("/api/v1/boxes", {
    data: {
      idempotencyKey: crypto.randomUUID(),
      name: `E2E weight ${crypto.randomUUID()}`,
      lengthIn: 10,
      widthIn: 8,
      heightIn: 4,
      maxWeightOz: 37,
      tareWeightOz: null,
    },
  });
  expect(created.ok()).toBe(true);
  const box = await created.json();

  await withSettingsLock(async () => {
    try {
      await page.request.patch("/api/v1/settings", { data: { weightDisplay: "LB_OZ" } });
      await page.goto("/boxes");
      const row = page.getByRole("row", { name: new RegExp(box.name) });
      await expect(row).toContainText("2 lb 5 oz");

      await page.goto("/settings");
      const general = page.getByRole("form", { name: "General" });
      // React Aria hides the native input; people click the label.
      await general.getByText(/^Decimal pounds/).click();
      await expect(general.getByRole("radio", { name: /Decimal pounds/ })).toBeChecked();
      await general.getByRole("button", { name: "Save" }).click();
      await expect(general.getByRole("status")).toHaveText("Settings saved.");

      await page.goto("/boxes");
      await expect(row).toContainText("2.31 lb");
    } finally {
      await page.request.patch("/api/v1/settings", { data: { weightDisplay: "LB_OZ" } });
      await page.request.post(`/api/v1/boxes/${box.id}/archive`);
    }
  });
});

test("signed-out callers can't read public settings", async ({ request }) => {
  const response = await request.get("/api/v1/settings/public");
  expect(response.status()).toBe(401);
  expect((await response.json()).data).toEqual({ messageKey: "errors.unauthenticated" });
});

test("checks the browser makes before saving use the app's messages", async ({ page }) => {
  await signInAs(page, ["ADMIN"]);
  await page.goto("/settings");
  const general = page.getByRole("form", { name: "General" });

  await general.getByLabel("Sync interval", { exact: false }).fill("");
  await general.getByRole("group", { name: "Ship-from address" }).getByLabel("Email").fill("nope");
  await general.getByRole("button", { name: "Save" }).click();

  await expect(general.getByText(en.errors.field.required)).toBeVisible();
  await expect(general.getByText(en.errors.field.email)).toBeVisible();
});

test("saving sends only the fields this form changed, so another admin's change survives", async ({
  page,
}) => {
  await signInAs(page, ["ADMIN"]);
  await withSettingsLock(async () => {
    const before = await (await page.request.get("/api/v1/settings")).json();
    try {
      await page.goto("/settings");
      const general = page.getByRole("form", { name: "General" });
      await expect(general.getByLabel("Sync interval", { exact: false })).toBeVisible();

      // Someone else changes the idle lock after this page loaded.
      const otherIdleLock = before.stationIdleLockMinutes === 9 ? 10 : 9;
      await page.request.patch("/api/v1/settings", {
        data: { stationIdleLockMinutes: otherIdleLock },
      });

      const nextSync = before.syncIntervalMinutes === 7 ? 8 : 7;
      await general.getByLabel("Sync interval", { exact: false }).fill(String(nextSync));
      const request = page.waitForRequest("**/rpc/settings/update");
      await general.getByRole("button", { name: "Save" }).click();
      expect(Object.keys((await request).postDataJSON().json)).toEqual(["syncIntervalMinutes"]);
      await expect(general.getByRole("status")).toHaveText("Settings saved.");

      const after = await (await page.request.get("/api/v1/settings")).json();
      expect(after).toMatchObject({
        syncIntervalMinutes: nextSync,
        stationIdleLockMinutes: otherIdleLock,
      });
    } finally {
      await page.request.patch("/api/v1/settings", {
        data: { stationIdleLockMinutes: before.stationIdleLockMinutes },
      });
    }
  });
});
