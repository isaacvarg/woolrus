import { expect, type Page, test } from "@playwright/test";
import { signInAs } from "./support/auth";
import { createOrder, deleteCreatedOrders } from "./support/orders";
import { ensureShipFrom, runRateFetch } from "./support/rates";
import { withSettingsLock } from "./support/settings-lock";

// Rates on Packing → QA against both fakes (SHIPPING_PROVIDERS=fake). Provider accounts are
// global, so the test takes its turn through withSettingsLock and leaves both providers off and
// without credentials, as carriers.spec.ts expects.

const api = "/api/v1/shipping";

test.afterAll(() => deleteCreatedOrders());

type CarrierConfig = {
  id: string;
  name: string;
  enabled: boolean;
  services: { id: string; code: string; enabled: boolean }[];
};

const credentials = {
  SHIPSTATION: { apiKey: "e2e-rates" },
  BRIDGE_SOURCE: { apiKey: "e2e-rates", customerId: "E2E" },
} as const;

async function ok(response: Promise<{ ok(): boolean; status(): number; url(): string }>) {
  const r = await response;
  expect(r.ok(), `${r.status()} ${r.url()}`).toBe(true);
}

/**
 * Turns a provider on and syncs it, with exactly one service on: `service` of `carrier`.
 */
async function enableOnly(
  admin: Page,
  provider: keyof typeof credentials,
  carrier: string,
  service: string,
) {
  await ok(
    admin.request.put(`${api}/providers/${provider}/credentials`, {
      data: { credentials: credentials[provider] },
    }),
  );
  await ok(admin.request.post(`${api}/providers/${provider}/enabled`, { data: { enabled: true } }));
  await ok(admin.request.post(`${api}/providers/${provider}/sync`));
  const config: { provider: string; carriers: CarrierConfig[] }[] = await (
    await admin.request.get(`${api}/config`)
  ).json();
  for (const c of config.find((p) => p.provider === provider)?.carriers ?? []) {
    await ok(
      admin.request.post(`${api}/carriers/${c.id}/enabled`, {
        data: { enabled: c.name === carrier },
      }),
    );
    for (const s of c.services) {
      await ok(
        admin.request.post(`${api}/services/${s.id}/enabled`, {
          data: { enabled: c.name === carrier && s.code === service },
        }),
      );
    }
  }
}

async function resetProviders(admin: Page) {
  for (const provider of Object.keys(credentials)) {
    await admin.request.delete(`${api}/providers/${provider}/credentials`);
  }
}

/** A packer packs the order's one unit into a custom box, weighs it and finishes. */
async function packAndFinish(page: Page, order: { id: string; number: string }, name: string) {
  await signInAs(page, ["PACKER"]);
  await page.goto("/queue/packing");
  await page.getByRole("searchbox", { name: "Search orders" }).fill(name);
  await page
    .getByRole("row", { name: new RegExp(order.number) })
    .getByRole("button", { name: "Start packing" })
    .click();
  await expect(page).toHaveURL(`/pack/${order.id}`, { timeout: 20_000 });
  await page.getByRole("button", { name: "Add package" }).click();
  const dialog = page.getByRole("dialog", { name: "Choose a box" });
  await dialog.getByLabel("Length").fill("5");
  await dialog.getByLabel("Width").fill("5");
  await dialog.getByLabel("Height").fill("5");
  await dialog.getByRole("button", { name: "Use this size" }).click();
  await page.getByRole("button", { name: "Put one E2E item in the selected package" }).click();
  const pkg = page.getByTestId("pack-package");
  await pkg.getByLabel("oz", { exact: true }).fill("9");
  await pkg.getByRole("button", { name: "Save weight" }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page).toHaveURL("/queue/packing", { timeout: 20_000 });
}

function rateRows(page: Page) {
  return page
    .getByRole("table", { name: "Rates for package 1" })
    .getByRole("row")
    .filter({ has: page.getByRole("cell") });
}

test("packing → QA fetches merged rates from both providers; a refresh skips a disabled one", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const admin = await (await browser.newContext()).newPage();
  const qa = await (await browser.newContext()).newPage();
  try {
    await signInAs(admin, ["ADMIN"]);
    await signInAs(qa, ["QA"]);
    await withSettingsLock(async () => {
      try {
        await ensureShipFrom();
        await enableOnly(admin, "SHIPSTATION", "Demo Ground", "demo_ground");
        await enableOnly(admin, "BRIDGE_SOURCE", "Demo Ground", "GND");

        const name = `E2E ${crypto.randomUUID()}`;
        const order = await createOrder({ customerName: name, quantity: 1, status: "PACKING" });
        await packAndFinish(page, order, name);
        expect(await runRateFetch(order.id)).toEqual({ status: "done" });

        await qa.goto(`/orders/${order.id}`);
        const shipping = qa.getByRole("region", { name: "Shipping" });
        await expect(shipping.getByTestId("ship-to")).toContainText("1 Main St");
        // 9 oz: Bridge Source's Demo Ground at $5.47 beats ShipStation's at $5.58.
        const rows = rateRows(qa);
        await expect(rows).toHaveCount(2);
        await expect(rows.nth(0)).toContainText("Bridge Source");
        await expect(rows.nth(0)).toContainText("$5.47");
        await expect(rows.nth(0)).toContainText("Selected");
        await expect(rows.nth(1)).toContainText("ShipStation");
        await expect(rows.nth(1)).toContainText("$5.58");
        await expect(rows.nth(1)).not.toContainText("Selected");

        await ok(
          admin.request.post(`${api}/providers/BRIDGE_SOURCE/enabled`, {
            data: { enabled: false },
          }),
        );
        await shipping.getByRole("button", { name: "Refresh rates" }).click();
        await expect(qa.getByText("Fetching the rates again.")).toBeVisible();
        expect(await runRateFetch(order.id)).toEqual({ status: "done" });
        await qa.reload();

        await expect(rows).toHaveCount(1);
        await expect(rows.nth(0)).toContainText("ShipStation");
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

test("a corrected address shows beside the original, and Use original address re-rates", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const admin = await (await browser.newContext()).newPage();
  const qa = await (await browser.newContext()).newPage();
  try {
    await signInAs(admin, ["ADMIN"]);
    await signInAs(qa, ["QA"]);
    await withSettingsLock(async () => {
      try {
        await ensureShipFrom();
        await enableOnly(admin, "SHIPSTATION", "Demo Ground", "demo_ground");

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
        const shipTo = qa.getByRole("region", { name: "Shipping" }).getByTestId("ship-to");
        await expect(shipTo).toContainText("Corrected");
        await expect(shipTo.getByTestId("ship-to-original")).toContainText("1 Main Street");
        await expect(shipTo.getByTestId("ship-to-corrected")).toContainText("1 Main St ·");
        await expect(shipTo).toContainText("Changed the street.");
        await expect(rateRows(qa)).toHaveCount(1);

        await shipTo.getByRole("button", { name: "Use original address" }).click();
        await expect(
          qa.getByText("Using the original address. Fetching rates again."),
        ).toBeVisible();
        await expect(rateRows(qa)).toHaveCount(0);
        expect(await runRateFetch(order.id)).toEqual({ status: "done" });
        await qa.reload();

        await expect(shipTo).toContainText("Not checked");
        await expect(shipTo).toContainText("1 Main Street");
        await expect(shipTo.getByTestId("ship-to-original")).toHaveCount(0);
        await expect(shipTo.getByRole("button", { name: "Use original address" })).toHaveCount(0);
        await expect(rateRows(qa)).toHaveCount(1);
        await expect(rateRows(qa).nth(0)).toContainText("Selected");
      } finally {
        await resetProviders(admin);
      }
    });
  } finally {
    await admin.context().close();
    await qa.context().close();
  }
});

test("a Picker sees an order's rates but can't refresh them or change the ship-to", async ({
  page,
}) => {
  const order = await createOrder({ status: "QA" });
  await signInAs(page, ["PICKER"]);
  await page.goto(`/orders/${order.id}`);
  // Created straight in QA with no package: nothing to show yet.
  await expect(page.getByRole("region", { name: "Shipping" })).toHaveCount(0);

  for (const action of ["rates/refresh", "ship-to/recheck", "ship-to/use-original"]) {
    const refused = await page.request.post(`/api/v1/orders/${order.id}/${action}`);
    expect(refused.status(), action).toBe(403);
  }
  const read = await page.request.get(`/api/v1/orders/${order.id}/shipping`);
  expect(read.ok()).toBe(true);
});
