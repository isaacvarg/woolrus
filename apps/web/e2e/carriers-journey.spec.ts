import { expect, type Locator, type Page, test } from "@playwright/test";
import { signInAs } from "./support/auth";
import { openNav } from "./support/nav";
import { createOrder, deleteCreatedOrders } from "./support/orders";
import { ensureShipFrom, packAndFinish, rateRows, runRateFetch } from "./support/rates";
import { withSettingsLock } from "./support/settings-lock";

// SPEC-carriers criterion 16: the carriers journey end to end against both fakes
// (SHIPPING_PROVIDERS=fake), with the admin's part done through Settings → Shipping. Provider
// accounts are global, so it takes its turn through withSettingsLock and leaves both providers off
// and without credentials, as carriers.spec.ts expects.

test.afterAll(() => deleteCreatedOrders());

const providers = {
  ShipStation: {
    id: "SHIPSTATION",
    credentials: { "API key": "e2e-journey" },
    services: {
      "Demo Ground": ["Demo Ground", "Demo Ground Saver"],
      "Demo Express": ["Demo Express", "Demo Express International"],
    },
  },
  "Bridge Source": {
    id: "BRIDGE_SOURCE",
    credentials: { "API key": "e2e-journey", "Customer ID": "E2E" },
    services: {
      "Demo Ground": ["Demo Ground", "Demo Ground Economy"],
      "Demo Express": ["Demo Express", "Demo Express International"],
    },
  },
} as const;
type ProviderName = keyof typeof providers;

/** Flips a switch only if it isn't already where it should be (carriers survive earlier tests). */
async function setSwitch(toggle: Locator, on: boolean) {
  if ((await toggle.isChecked()) !== on) await toggle.click({ force: true });
  await expect(toggle).toBeChecked({ checked: on });
}

/**
 * Adds credentials, turns the provider on, syncs and leaves exactly the "Demo Ground" carrier and
 * service on.
 */
async function setUpProvider(admin: Page, name: ProviderName) {
  const card = admin.getByRole("region", { name });
  // Bridge Source's card has a second Save, for its base URL.
  const credentials = card.getByRole("group", { name: "Credentials" });
  await credentials.getByRole("button", { name: /^(Add|Replace)$/ }).click();
  for (const [label, value] of Object.entries(providers[name].credentials)) {
    await credentials.getByLabel(label, { exact: true }).fill(value);
  }
  await credentials.getByRole("button", { name: "Save" }).click();
  await expect(credentials.getByText("Set", { exact: true }).first()).toBeVisible();

  await setSwitch(card.getByRole("switch", { name: `Use ${name}` }), true);
  await card.getByRole("button", { name: "Sync carriers" }).click();
  await expect(admin.getByText(new RegExp(`${name} synced`))).toBeVisible();

  for (const [carrier, services] of Object.entries(providers[name].services)) {
    await setSwitch(
      card.getByRole("switch", { name: `Use carrier ${carrier}`, exact: true }),
      carrier === "Demo Ground",
    );
    for (const service of services) {
      await setSwitch(
        card.getByRole("switch", { name: `Use ${carrier} ${service}`, exact: true }),
        carrier === "Demo Ground" && service === "Demo Ground",
      );
    }
  }
}

async function resetProviders(admin: Page) {
  for (const { id } of Object.values(providers)) {
    await admin.request.delete(`/api/v1/shipping/providers/${id}/credentials`);
  }
}

test("an admin sets up both providers, packing rates from both, the QA user re-rates", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const admin = await (await browser.newContext()).newPage();
  const qa = await (await browser.newContext()).newPage();
  try {
    await signInAs(admin, ["ADMIN"]);
    await signInAs(qa, ["QA"]);

    // A QA user has no way into Settings → Shipping.
    await qa.goto("/boxes");
    await openNav(qa);
    await expect(qa.getByRole("link", { name: "Boxes" })).toBeVisible();
    await expect(qa.getByRole("link", { name: "Shipping", exact: true })).toHaveCount(0);

    await withSettingsLock(async () => {
      try {
        await ensureShipFrom();
        await admin.goto("/settings/shipping");
        await setUpProvider(admin, "ShipStation");
        await setUpProvider(admin, "Bridge Source");

        const name = `E2E ${crypto.randomUUID()}`;
        // The fake ShipStation abbreviates "Street".
        const order = await createOrder({
          customerName: name,
          quantity: 1,
          status: "PACKING",
          street: "1 Main Street",
        });
        await packAndFinish(page, order, name);
        expect(await runRateFetch(order.id)).toEqual({ status: "done" });

        await qa.goto(`/orders/${order.id}`);
        const shipping = qa.getByRole("region", { name: "Shipping" });
        const shipTo = shipping.getByTestId("ship-to");
        await expect(shipTo).toContainText("Corrected");
        await expect(shipTo.getByTestId("ship-to-original")).toContainText("1 Main Street");
        await expect(shipTo.getByTestId("ship-to-corrected")).toContainText("1 Main St ·");
        // 9 oz: Bridge Source's Demo Ground at $5.47 beats ShipStation's at $5.58.
        const rows = rateRows(qa);
        await expect(rows).toHaveCount(2);
        await expect(rows.nth(0)).toContainText("Bridge Source");
        await expect(rows.nth(0)).toContainText("$5.47");
        await expect(rows.nth(0)).toContainText("Selected");
        await expect(rows.nth(1)).toContainText("ShipStation");
        await expect(rows.nth(1)).toContainText("$5.58");
        await expect(rows.nth(1)).not.toContainText("Selected");

        await shipTo.getByRole("button", { name: "Use original address" }).click();
        await expect(
          qa.getByText("Using the original address. Fetching rates again."),
        ).toBeVisible();
        await expect(rows).toHaveCount(0);
        expect(await runRateFetch(order.id)).toEqual({ status: "done" });
        await qa.reload();
        await expect(shipTo).toContainText("1 Main Street");
        await expect(shipTo.getByTestId("ship-to-original")).toHaveCount(0);
        await expect(rows).toHaveCount(2);
        await expect(rows.nth(0)).toContainText("Selected");

        await setSwitch(
          admin
            .getByRole("region", { name: "Bridge Source" })
            .getByRole("switch", { name: "Use Bridge Source" }),
          false,
        );
        await shipping.getByRole("button", { name: "Refresh rates" }).click();
        await expect(qa.getByText("Fetching the rates again.")).toBeVisible();
        expect(await runRateFetch(order.id)).toEqual({ status: "done" });
        await qa.reload();
        await expect(rows).toHaveCount(1);
        await expect(rows.nth(0)).toContainText("ShipStation");
        await expect(rows.nth(0)).toContainText("$5.58");
        await expect(rows.nth(0)).toContainText("Selected");
      } finally {
        await resetProviders(admin);
      }
    });
  } finally {
    await admin.context().close();
    await qa.context().close();
  }
});
