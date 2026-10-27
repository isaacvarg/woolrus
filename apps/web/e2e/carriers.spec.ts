import { expect, type Page, test } from "@playwright/test";
import en from "@woolrus/i18n/messages/en.json" with { type: "json" };
import { signInAs } from "./support/auth";
import { openNav } from "./support/nav";
import { withSettingsLock } from "./support/settings-lock";

// Settings → Shipping against the fake providers (SHIPPING_PROVIDERS=fake): they accept any
// credentials except "invalid". Provider accounts are global, so tests that change them take turns
// through withSettingsLock and leave ShipStation off and without credentials.

const LEAK_TAIL = "QZXJ";

async function resetShipStation(page: Page) {
  await page.request.delete("/api/v1/shipping/providers/SHIPSTATION/credentials");
}

function card(page: Page, name: string) {
  return page.getByRole("region", { name });
}

async function saveApiKey(page: Page, value: string) {
  const shipStation = card(page, "ShipStation");
  await shipStation.getByRole("button", { name: /^(Add|Replace)$/ }).click();
  await shipStation.getByLabel("API key").fill(value);
  await shipStation.getByRole("button", { name: "Save" }).click();
  await expect(shipStation.getByText("Set", { exact: true })).toBeVisible();
}

test("an admin sets credentials, tests, enables and disables a provider", async ({ page }) => {
  const apiKey = `e2e-${crypto.randomUUID()}-${LEAK_TAIL}`;
  const bodies: Promise<string>[] = [];
  page.on("response", (response) => {
    if (/\/(rpc|api\/v1)\//.test(response.url())) bodies.push(response.text().catch(() => ""));
  });
  await signInAs(page, ["ADMIN"]);
  await withSettingsLock(async () => {
    try {
      await resetShipStation(page);
      await page.goto("/settings/shipping");
      const shipStation = card(page, "ShipStation");
      await expect(shipStation.getByText("Not set", { exact: true })).toBeVisible();

      await saveApiKey(page, apiKey);
      await shipStation.getByRole("button", { name: "Test connection" }).click();
      await expect(shipStation.getByText("Connected.")).toBeVisible();

      const toggle = shipStation.getByRole("switch", { name: "Use ShipStation" });
      await toggle.click({ force: true });
      await expect(toggle).toBeChecked();
      await page.reload();
      await expect(card(page, "ShipStation").getByRole("switch")).toBeChecked();

      await card(page, "ShipStation").getByRole("switch").click({ force: true });
      await expect(card(page, "ShipStation").getByRole("switch")).not.toBeChecked();

      const received = (await Promise.all(bodies)).join("\n");
      expect(received).toContain('"configured"');
      expect(received).not.toContain(LEAK_TAIL);
    } finally {
      await resetShipStation(page);
    }
  });
});

test("a provider whose credentials fail its test can't be enabled", async ({ page }) => {
  await signInAs(page, ["ADMIN"]);
  await withSettingsLock(async () => {
    try {
      await resetShipStation(page);
      await page.goto("/settings/shipping");
      const shipStation = card(page, "ShipStation");

      await saveApiKey(page, "invalid");
      await shipStation.getByRole("button", { name: "Test connection" }).click();
      await expect(shipStation.getByText(en.errors.shipping.unauthorized)).toBeVisible();

      await shipStation.getByRole("switch", { name: "Use ShipStation" }).click({ force: true });
      await expect(page.getByText(en.errors.carriers.providerUnreachable)).toBeVisible();
      await expect(shipStation.getByRole("switch")).not.toBeChecked();

      // Clearing takes the credentials away again.
      await shipStation.getByRole("button", { name: "Clear" }).click();
      await shipStation.getByRole("button", { name: "Yes, clear" }).click();
      await expect(shipStation.getByText("Not set", { exact: true })).toBeVisible();
    } finally {
      await resetShipStation(page);
    }
  });
});

test("a QA user has no Shipping settings link and is refused at /settings/shipping", async ({
  page,
}) => {
  await signInAs(page, ["QA"]);
  await page.goto("/boxes");
  await openNav(page);
  await expect(page.getByRole("link", { name: "Boxes" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Shipping", exact: true })).toHaveCount(0);

  await page.goto("/settings/shipping");
  await expect(page.getByText(en.errors.forbidden)).toBeVisible();
  await expect(page.getByRole("region", { name: "ShipStation" })).toHaveCount(0);
});

test("an admin reaches Shipping from the nav, and Integrations no longer shows ShipStation", async ({
  page,
}) => {
  await signInAs(page, ["ADMIN"]);
  await page.goto("/settings");
  await expect(page.getByRole("region", { name: "Lumexia" })).toBeVisible();
  await expect(page.getByRole("region", { name: "ShipStation" })).toHaveCount(0);

  await openNav(page);
  await page.getByRole("link", { name: "Shipping", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Shipping", level: 1 })).toBeVisible();
  await expect(card(page, "ShipStation")).toBeVisible();
  await expect(card(page, "Bridge Source")).toBeVisible();
});
