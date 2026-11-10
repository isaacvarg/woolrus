import { expect, type Locator, type Page, test } from "@playwright/test";
import en from "@woolrus/i18n/messages/en.json" with { type: "json" };
import es from "@woolrus/i18n/messages/es.json" with { type: "json" };
import { signInAs } from "./support/auth";
import { openNav } from "./support/nav";
import { withSettingsLock } from "./support/settings-lock";

// There is one settings row, and the desktop and tablet projects run in parallel. Tests that change
// it take turns through withSettingsLock and put back anything other tests could trip over.

/** The base URL form's own status: the Lumexia card also holds the Lot rules section's status. */
const urlSaved = (lumexia: Locator) =>
  lumexia.locator("form", { has: lumexia.page().getByLabel("API base URL") }).getByRole("status");

test("an admin saves general settings and they persist after a reload", async ({ page }) => {
  await signInAs(page, ["ADMIN"]);
  await withSettingsLock(async () => {
    await page.goto("/settings");
    const general = page.getByRole("form", { name: "General" });
    const field = general.getByLabel("Sync interval", { exact: false });
    const next = Number(await field.inputValue()) === 7 ? 8 : 7;
    const claimExpiry = general.getByLabel("Order claim expiry", { exact: false });
    const nextExpiry = Number(await claimExpiry.inputValue()) === 45 ? 30 : 45;

    await field.fill(String(next));
    await claimExpiry.fill(String(nextExpiry));
    await general.getByRole("button", { name: "Save" }).click();
    await expect(general.getByRole("status")).toHaveText("Settings saved.");

    await page.reload();
    await expect(general.getByLabel("Sync interval", { exact: false })).toHaveValue(String(next));
    await expect(general.getByLabel("Order claim expiry", { exact: false })).toHaveValue(
      String(nextExpiry),
    );
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

test("correcting a field the server rejected clears only its message and lets the form save", async ({
  page,
}) => {
  await signInAs(page, ["ADMIN"]);
  await withSettingsLock(async () => {
    // The API can't unset the address, so put back the one that was there, if any.
    const before = (await (await page.request.get("/api/v1/settings")).json()).shipFromAddress;
    try {
      await page.goto("/settings");
      const general = page.getByRole("form", { name: "General" });
      const shipFrom = general.getByRole("group", { name: "Ship-from address" });
      await shipFrom.getByLabel("Contact name").fill("E2E Shipping");
      await shipFrom.getByLabel("Phone").fill("555-010-2030");
      await shipFrom.getByLabel("Address line 1").fill("100 Dock Street");
      await shipFrom.getByLabel("City").fill("Austin");
      await shipFrom.getByLabel("State").fill("Texas");
      await shipFrom.getByLabel("ZIP code").fill("7870");
      await general.getByRole("button", { name: "Save" }).click();

      const state = shipFrom.getByRole("textbox", { name: "State" });
      const zip = shipFrom.getByRole("textbox", { name: "ZIP code" });
      await expect(zip).toHaveAttribute("aria-invalid", "true");
      await expect(shipFrom.getByText(en.errors.field.usZip)).toBeVisible();
      await expect(state).toHaveAttribute("aria-invalid", "true");

      // Fixing one field drops its message; the other field's stays until it's fixed too.
      await zip.fill("78702");
      await expect(zip).not.toHaveAttribute("aria-invalid", "true");
      await expect(shipFrom.getByText(en.errors.field.usZip)).toHaveCount(0);
      await expect(state).toHaveAttribute("aria-invalid", "true");

      await state.fill("TX");
      await general.getByRole("button", { name: "Save" }).click();
      await expect(general.getByRole("status")).toHaveText("Settings saved.");
      await expect(state).not.toHaveAttribute("aria-invalid", "true");
    } finally {
      if (before)
        await page.request.patch("/api/v1/settings", { data: { shipFromAddress: before } });
    }
  });
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

/**
 * Records every API response body the page receives (RPC and REST), to search them for a secret.
 * Secrets in these tests end in a tail that can't occur by chance in ids or timestamps.
 */
function recordApiResponses(page: Page) {
  const bodies: Promise<string>[] = [];
  page.on("response", (response) => {
    if (/\/(rpc|api\/v1)\//.test(response.url())) bodies.push(response.text().catch(() => ""));
  });
  return async () => {
    const all = (await Promise.all(bodies)).join("\n");
    expect(all).toContain('"configured"'); // the recorder really saw the settings responses
    return all;
  };
}

const LEAK_TAIL = "QZXJ";

/** A secret's row on the settings page: its card, then the row named after the secret. */
function secretRow(page: Page, card: string, secret: string) {
  return page.getByRole("region", { name: card }).getByRole("group", { name: secret, exact: true });
}

test("replacing a secret marks it set without showing it, and clearing unsets it", async ({
  page,
}) => {
  // Not a secret the dev stack relies on: the Woo webhook secret is what its webhooks are signed with.
  const value = `e2e-${crypto.randomUUID()}-${LEAK_TAIL}`;
  await signInAs(page, ["ADMIN"]);
  const apiResponses = recordApiResponses(page);
  await withSettingsLock(async () => {
    try {
      await page.request.delete("/api/v1/settings/secrets/lumexiaApiKey");
      await page.goto("/settings");
      const row = secretRow(page, "Lumexia", "API key");
      await expect(row.getByText("Not set", { exact: true })).toBeVisible();

      // Keyboard focus follows the row: into the field, back to the button that opened it.
      await row.getByRole("button", { name: "Add" }).click();
      await expect(row.getByLabel("New value")).toBeFocused();
      await row.getByLabel("New value").fill(value);
      await row.getByRole("button", { name: "Save" }).click();
      await expect(row.getByText("Set", { exact: true })).toBeVisible();
      await expect(row.getByLabel("New value")).toHaveCount(0);
      await expect(row.getByRole("button", { name: "Replace" })).toBeFocused();

      await page.reload();
      await expect(row.getByText("Set", { exact: true })).toBeVisible();
      await row.getByRole("button", { name: "Replace" }).click();
      await expect(row.getByLabel("New value")).toHaveValue("");
      expect(await page.content()).not.toContain(value);
      await row.getByRole("button", { name: "Cancel" }).click();

      await row.getByRole("button", { name: "Clear" }).click();
      await expect(row.getByRole("button", { name: "Cancel" })).toBeFocused();
      await row.getByRole("button", { name: "Yes, clear" }).click();
      await expect(row.getByText("Not set", { exact: true })).toBeVisible();
      await expect(row.getByRole("button", { name: "Add" })).toBeFocused();

      const received = await apiResponses();
      expect(received).not.toContain(value);
      expect(received).not.toContain(LEAK_TAIL);
    } finally {
      await page.request.delete("/api/v1/settings/secrets/lumexiaApiKey");
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
  const row = secretRow(page, "Lumexia", "API key");

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
      await expect(urlSaved(lumexia)).toHaveText("Saved.");
      await page.reload();
      await expect(lumexia.getByLabel("API base URL")).toHaveValue("https://lumexia.example.com");

      await lumexia.getByLabel("API base URL").fill("");
      await lumexia.getByRole("button", { name: "Save" }).click();
      await expect(urlSaved(lumexia)).toHaveText("Saved.");
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
  const secret = `e2e-${crypto.randomUUID()}-${LEAK_TAIL}`;
  await signInAs(page, ["ADMIN"]);
  const apiResponses = recordApiResponses(page);
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
      const received = await apiResponses();
      expect(received).not.toContain(secret);
      expect(received).not.toContain(LEAK_TAIL);
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

test("moving the Lumexia URL to another server asks first, then shows its key as Not set", async ({
  page,
}) => {
  await signInAs(page, ["ADMIN"]);
  await withSettingsLock(async () => {
    try {
      await page.request.patch("/api/v1/settings", {
        data: { lumexiaBaseUrl: "https://lumexia.example.com/api" },
      });
      await page.request.put("/api/v1/settings/secrets/lumexiaApiKey", {
        data: { value: `e2e-${crypto.randomUUID()}` },
      });
      await page.goto("/settings");
      const lumexia = page.getByRole("region", { name: "Lumexia" });
      const key = secretRow(page, "Lumexia", "API key");
      await expect(key.getByText("Set", { exact: true })).toBeVisible();

      // A path change stays on the same server: no question, key kept.
      await lumexia.getByLabel("API base URL").fill("https://lumexia.example.com/v2");
      await lumexia.getByRole("button", { name: "Save" }).click();
      await expect(urlSaved(lumexia)).toHaveText("Saved.");
      await expect(key.getByText("Set", { exact: true })).toBeVisible();

      // Another host: cancelling keeps everything as it was.
      await lumexia.getByLabel("API base URL").fill("https://lx.example.net");
      await lumexia.getByRole("button", { name: "Save" }).click();
      const dialog = page.getByRole("dialog", { name: "Remove the saved keys?" });
      await expect(dialog).toContainText("API key");
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(key.getByText("Set", { exact: true })).toBeVisible();

      await lumexia.getByRole("button", { name: "Save" }).click();
      await dialog.getByRole("button", { name: "Save and remove keys" }).click();
      await expect(urlSaved(lumexia)).toHaveText(en.settings.integrations.savedKeysCleared);
      await expect(key.getByText("Not set", { exact: true })).toBeVisible();
      await page.reload();
      await expect(lumexia.getByLabel("API base URL")).toHaveValue("https://lx.example.net");
      await expect(key.getByText("Not set", { exact: true })).toBeVisible();
    } finally {
      await page.request.delete("/api/v1/settings/secrets/lumexiaApiKey");
      await page.request.patch("/api/v1/settings", { data: { lumexiaBaseUrl: null } });
    }
  });
});

test("the WooCommerce card shows the webhook delivery URL and setup steps", async ({ page }) => {
  await signInAs(page, ["ADMIN"]);
  await page.goto("/settings");
  const woo = page.getByRole("region", { name: "WooCommerce" });
  const origin = new URL(page.url()).origin;
  await expect(woo.getByText(`${origin}/api/webhooks/woocommerce`)).toBeVisible();
  await expect(woo.getByRole("listitem")).toHaveCount(4);
});

// Test connection talks to the real dev store, which CI doesn't have.
test.describe("Test connection (dev stack)", () => {
  test.skip(!process.env.E2E_DEV_STACK, "needs the dev store (E2E_DEV_STACK=1)");

  test("reports the store's units", async ({ page }) => {
    await signInAs(page, ["ADMIN"]);
    await page.goto("/settings");
    const woo = page.getByRole("region", { name: "WooCommerce" });
    await woo.getByRole("button", { name: "Test connection" }).click();
    await expect(woo.getByText(/^Connected\. The store uses lbs for weight/)).toBeVisible();
  });
});

test("Test connection explains a refused key in the user's language", async ({ page }) => {
  // The server half (a 401 from the store → errors.sync.unauthorized) is covered by core's tests.
  // Saving a wrong key here would break the shared dev stack's sync for everyone, so the answer is
  // stubbed and only the card's translation is checked.
  await page.route(/\/rpc\/sync\/testConnection/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ json: { ok: false, messageKey: "errors.sync.unauthorized" } }),
    }),
  );
  await signInAs(page, ["ADMIN"]);
  await page.goto("/settings");
  const woo = page.getByRole("region", { name: "WooCommerce" });
  await woo.getByRole("button", { name: "Test connection" }).click();
  await expect(woo.getByText(en.errors.sync.unauthorized)).toBeVisible();
});

test("Lumexia's Test connection shows ok, unconfigured and down, in en and es", async ({
  page,
}) => {
  // The states themselves are core's (connection.test.ts); this checks the card shows each one.
  // Stubbed: the settings row is shared, and the dev stack has no Lumexia to answer.
  const answers = [
    { status: "ok" },
    { status: "unconfigured", messageKey: "errors.lumexia.unconfigured" },
    { status: "down", messageKey: "errors.lumexia.unauthorized" },
  ];
  let next = 0;
  await page.route(/\/rpc\/lumexia\/testConnection/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ json: answers[next++ % answers.length] }),
    }),
  );
  await signInAs(page, ["ADMIN"]);
  for (const [messages, locale] of [
    [en, "en"],
    [es, "es"],
  ] as const) {
    await page.request.patch("/api/v1/me/preferences", { data: { locale } });
    await page.goto("/settings");
    const lumexia = page.getByRole("region", { name: "Lumexia" });
    const button = lumexia.getByRole("button", {
      name: messages.settings.integrations.testConnection,
    });
    for (const text of [
      messages.settings.integrations.lumexiaTestOk,
      messages.errors.lumexia.unconfigured,
      messages.errors.lumexia.unauthorized,
    ]) {
      await button.click();
      await expect(lumexia.getByTestId("lumexia-test-result")).toHaveText(text);
    }
  }
});

test("an admin switches on a lot rule and saves it, and sees the tag and removed ids, in en and es", async ({
  page,
}) => {
  // Lumexia's types are stubbed (the dev stack has no Lumexia); saving goes through for real.
  const BASE = "0190a000-0000-7000-8000-0000000000a1";
  const GONE = "0190a000-0000-7000-8000-0000000000ff";
  const STOCKED = "0190a000-0000-7000-8000-0000000000c1";
  const empty = { itemTypeIds: [], procurementTypeIds: [], inventoryTypeIds: [] };
  await page.route(/\/rpc\/lumexia\/lotRules/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          readOnly: false,
          itemTypes: {
            types: [{ id: BASE, name: "Production base", needsLot: false }],
            unknownIds: [],
          },
          procurementTypes: { types: [], unknownIds: [GONE] },
          inventoryTypes: {
            types: [{ id: STOCKED, name: "Stocked", needsLot: false, isTracked: true }],
            unknownIds: [],
          },
        },
      }),
    }),
  );
  await signInAs(page, ["ADMIN"]);
  await withSettingsLock(async () => {
    try {
      for (const [messages, locale] of [
        [es, "es"],
        [en, "en"],
      ] as const) {
        const t = messages.settings.integrations.lotRules;
        await page.request.patch("/api/v1/me/preferences", { data: { locale } });
        await page.goto("/settings");
        const rules = page.getByRole("region", { name: t.title });
        await expect(rules.getByText(t.tracked)).toBeVisible();
        await expect(rules.getByText(t.removed)).toBeVisible();
        await expect(rules.getByText(t.anyMatch)).toBeVisible();
      }

      const rules = page.getByRole("region", { name: en.settings.integrations.lotRules.title });
      const save = rules.getByRole("button", { name: en.settings.integrations.lotRules.save });
      await expect(save).toBeDisabled();
      // React Aria's switch input is visually hidden, so Playwright clicks it with force.
      const base = rules.getByRole("switch", { name: "Production base" });
      await base.click({ force: true });
      await expect(base).toBeChecked();
      await rules
        .getByRole("button", { name: en.settings.integrations.lotRules.switchOff })
        .click();
      await expect(rules.getByText(en.settings.integrations.lotRules.removed)).toBeHidden();
      const request = page.waitForRequest(/\/rpc\/lumexia\/setLotRules/);
      await save.click();
      expect((await request).postDataJSON().json).toEqual({ ...empty, itemTypeIds: [BASE] });
      await expect(rules.getByText(en.settings.integrations.saved)).toBeVisible();

      // Without a Lumexia to ask, the saved ids come back read-only.
      const saved = await (await page.request.get("/api/v1/lumexia/lot-rules")).json();
      expect(saved).toMatchObject({
        readOnly: true,
        itemTypes: { types: [{ id: BASE, name: null, needsLot: true }] },
        procurementTypes: { types: [] },
      });
    } finally {
      await page.request.put("/api/v1/lumexia/lot-rules", { data: empty });
    }
  });
});

test("lot rules are read-only, with the saved ids, while Lumexia is down", async ({ page }) => {
  const BASE = "0190a000-0000-7000-8000-0000000000a1";
  await page.route(/\/rpc\/lumexia\/lotRules/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          readOnly: true,
          messageKey: "errors.lumexia.unavailable",
          itemTypes: { types: [{ id: BASE, name: null, needsLot: true }], unknownIds: [] },
          procurementTypes: { types: [], unknownIds: [] },
          inventoryTypes: { types: [], unknownIds: [] },
        },
      }),
    }),
  );
  await signInAs(page, ["ADMIN"]);
  await page.goto("/settings");
  const rules = page.getByRole("region", { name: en.settings.integrations.lotRules.title });
  await expect(rules.getByText(en.errors.lumexia.unavailable, { exact: false })).toBeVisible();
  await expect(rules.getByText(BASE)).toBeVisible();
  await expect(rules.getByRole("switch")).toHaveCount(0);
  await expect(
    rules.getByRole("button", { name: en.settings.integrations.lotRules.save }),
  ).toHaveCount(0);
});

test("an admin sets the email sender and sends a test email, which is logged without a Resend key", async ({
  page,
}) => {
  await signInAs(page, ["ADMIN"]);
  await withSettingsLock(async () => {
    try {
      await page.request.delete("/api/v1/settings/secrets/resendApiKey");
      await page.goto("/settings");
      const email = page.getByRole("region", { name: "Email" });
      await expect(email.getByRole("group", { name: "Resend API key" })).toContainText("Not set");

      await email.getByLabel("Sender").fill("Woolrus no-reply@example.com");
      await email.getByRole("button", { name: "Save" }).click();
      // The rendered message, not the catalog's: its "<" is ICU-quoted.
      await expect(
        email.getByText(
          "Use an address like no-reply@example.com or Woolrus <no-reply@example.com>.",
        ),
      ).toBeVisible();

      await email.getByLabel("Sender").fill("Woolrus <no-reply@example.com>");
      await email.getByRole("button", { name: "Save" }).click();
      await expect(email.getByRole("status").first()).toHaveText("Saved.");
      await page.reload();
      await expect(email.getByLabel("Sender")).toHaveValue("Woolrus <no-reply@example.com>");

      await email.getByRole("button", { name: "Send test email" }).click();
      await expect(email.getByText(/written to the server log instead of sent/)).toBeVisible();
    } finally {
      await page.request.patch("/api/v1/settings", { data: { emailFrom: null } });
    }
  });
});

test("Send test email shows where it went, or Resend's refusal in the user's language", async ({
  page,
}) => {
  // Real Resend calls are covered by the adapter's fixtures; here only the card's messages.
  const replies = [
    { ok: true, to: "admin@example.test", via: "resend" },
    { ok: false, messageKey: "errors.email.unauthorized" },
  ];
  await page.route(/\/rpc\/settings\/sendTestEmail/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ json: replies.shift() }),
    }),
  );
  await signInAs(page, ["ADMIN"]);
  await page.goto("/settings");
  const email = page.getByRole("region", { name: "Email" });
  await email.getByRole("button", { name: "Send test email" }).click();
  await expect(email.getByText("Sent to admin@example.test. Check your inbox.")).toBeVisible();
  await email.getByRole("button", { name: "Send test email" }).click();
  await expect(email.getByText(en.errors.email.unauthorized)).toBeVisible();
});
