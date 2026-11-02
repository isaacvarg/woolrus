import { expect, type Page, test } from "@playwright/test";
import { encryptionKey, encryptSecret, pushToWoo } from "@woolrus/core";
import { createDb } from "@woolrus/db";
import { signInAs } from "./support/auth";
import { openNav } from "./support/nav";
import { deleteCreatedOrders } from "./support/orders";
import { qaJourneyOrder } from "./support/qa";
import { withSettingsLock } from "./support/settings-lock";
import { fakeStoreFor, type ShippingOrder, shippingOrder } from "./support/shipping";

// SPEC-shipping criterion 16: the shipping journeys on desktop and tablet, against the fake
// providers and the fake store (nothing here reaches a real store or carrier). CI starts no worker,
// so the `woo.push` job Ship enqueues is run by `pushToWoo` with a fake store.

const db = createDb();
const made: ShippingOrder[] = [];
test.afterAll(deleteCreatedOrders);
test.afterEach(async () => {
  for (const o of made.splice(0)) {
    await o.cleanup();
    await db.order.deleteMany({ where: { id: o.order.id } });
  }
});

/** The ShipStation account switched on with a made-up key (the fake accepts any); the old state is put back. */
async function enableShipStation() {
  const key = encryptionKey();
  if (!key) throw new Error("SETTINGS_ENCRYPTION_KEY is not set");
  const before = await db.shippingProviderAccount.findUnique({
    where: { provider: "SHIPSTATION" },
  });
  const credentialsEnc = encryptSecret(JSON.stringify({ apiKey: "e2e-fake" }), key);
  await db.shippingProviderAccount.upsert({
    where: { provider: "SHIPSTATION" },
    create: { provider: "SHIPSTATION", enabled: true, credentialsEnc },
    update: { enabled: true, credentialsEnc },
  });
  return () =>
    db.shippingProviderAccount.update({
      where: { provider: "SHIPSTATION" },
      data: { enabled: before?.enabled ?? false, credentialsEnc: before?.credentialsEnc ?? null },
    });
}

/** Voiding goes to the provider, so its account has to be on (the fake answers). */
async function withShipStation<T>(run: () => Promise<T>): Promise<T> {
  return withSettingsLock(async () => {
    const restore = await enableShipStation();
    try {
      return await run();
    } finally {
      await restore();
    }
  });
}

async function make(...args: Parameters<typeof shippingOrder>) {
  const o = await shippingOrder(...args);
  made.push(o);
  return o;
}

/** Opens the Ready queue filtered to this test's orders. */
async function readyQueue(page: Page, token: string) {
  await page.goto("/queue/ready");
  await page.getByRole("searchbox", { name: "Search orders" }).fill(token);
}
const rowOf = (page: Page, o: ShippingOrder) =>
  page.getByRole("row", { name: new RegExp(`#${o.order.number}`) });
/** Ticks a Ready queue row by tapping its box, as a shipper would. */
async function select(page: Page, o: ShippingOrder) {
  const box = page.getByRole("checkbox", { name: `Select #${o.order.number}` });
  await page.locator("label", { has: box }).click();
  await expect(box).toBeChecked();
}

const printCount = async (labelId: string) =>
  (await db.shippingLabel.findUniqueOrThrow({ where: { id: labelId } })).printCount;

test("print three Ready orders, reprint a label, ship them confirming the unprinted one, and see Sent to Woo with tracking", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const token = crypto.randomUUID().slice(0, 8);
  const a = await make({ customerName: `E2E ${token} A`, labels: ["ACTIVE"] });
  const b = await make({ customerName: `E2E ${token} B`, labels: ["ACTIVE", "ACTIVE"] });
  const c = await make({ customerName: `E2E ${token} C`, labels: ["ACTIVE"] });
  await signInAs(page, ["SHIPPER"]);
  await readyQueue(page, token);
  await expect(rowOf(page, c)).toBeVisible();
  await expect(rowOf(page, b)).toContainText("2");
  await expect(rowOf(page, b)).toContainText("Not printed");

  // Print a and b: one PDF with a's label and b's two, in that order.
  await select(page, a);
  await select(page, b);
  const [popup] = await Promise.all([
    page.waitForEvent("popup"),
    page.getByRole("button", { name: "Print labels (2)" }).click(),
  ]);
  await popup.close();
  const print = await expect
    .poll(() => db.labelPrint.findFirst({ where: { labelIds: { hasSome: a.labelIds } } }))
    .not.toBeNull()
    .then(() => db.labelPrint.findFirstOrThrow({ where: { labelIds: { hasSome: a.labelIds } } }));
  expect(print.labelIds).toEqual([...a.labelIds, ...b.labelIds]);
  const pdf = await page.request.get(`/api/label-prints/${print.id}.pdf`);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toContain("application/pdf");
  expect((await pdf.body()).subarray(0, 5).toString()).toBe("%PDF-");
  await expect.poll(() => printCount(a.labelIds[0] as string)).toBe(1);
  expect(await printCount(b.labelIds[1] as string)).toBe(1);
  expect(await printCount(c.labelIds[0] as string)).toBe(0);
  expect(
    await db.order.findUniqueOrThrow({ where: { id: a.order.id } }).then((o) => o.status),
  ).toBe("READY");

  // Reprint one label from the order page.
  await page.goto(`/orders/${b.order.id}`);
  const labels = page.getByTestId("order-labels");
  await expect(labels).toContainText("Printed 1×");
  const [reprint] = await Promise.all([
    page.waitForEvent("popup"),
    labels.getByRole("button", { name: "Reprint", exact: true }).first().click(),
  ]);
  await reprint.close();
  await expect.poll(() => printCount(b.labelIds[0] as string)).toBe(2);
  expect(await printCount(b.labelIds[1] as string)).toBe(1);

  // Ship all three: c was never printed, so the shipper is asked first.
  await readyQueue(page, token);
  for (const o of [a, b, c]) await select(page, o);
  await page.getByRole("button", { name: "Ship (3)" }).click();
  const dialog = page.getByRole("dialog", { name: "Labels never printed" });
  await expect(dialog).toContainText(c.order.number);
  expect(await db.order.count({ where: { id: c.order.id, status: "COMPLETED" } })).toBe(0);
  await dialog.getByRole("button", { name: "Ship anyway" }).click();
  await expect(page.getByText("3 orders shipped.")).toBeVisible();
  for (const o of [a, b, c]) {
    const shipped = await db.order.findUniqueOrThrow({ where: { id: o.order.id } });
    expect(shipped).toMatchObject({ status: "COMPLETED", wooPushStatus: "PENDING" });
  }

  // The worker's woo.push (fake store): the order page says so and lists the tracking numbers.
  const { store, wooId } = await fakeStoreFor(b.order.id);
  expect(await pushToWoo(db, store, { orderId: b.order.id })).toEqual({ outcome: "succeeded" });
  expect((await store.getOrder(wooId))?.status).toBe("completed");
  await page.goto(`/orders/${b.order.id}`);
  await expect(page.getByText("Sent to Woo")).toBeVisible();
  const tracking = (
    await db.shippingLabel.findMany({
      where: { id: { in: b.labelIds } },
      orderBy: { package: { number: "asc" } },
    })
  ).map((l) => l.trackingNumber as string);
  for (const number of tracking) {
    await expect(page.getByTestId("order-labels")).toContainText(number);
    expect(store.notesOf(wooId)[0]?.note).toContain(number);
  }
});

test("a Picker can't ship or print, and has no PDF", async ({ page }) => {
  const token = crypto.randomUUID().slice(0, 8);
  const a = await make({ customerName: `E2E ${token} A` });
  await signInAs(page, ["PICKER"]);
  await readyQueue(page, token);
  await expect(rowOf(page, a)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Ship/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Print labels/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Repack/ })).toHaveCount(0);
  expect(
    (await page.request.get("/api/label-prints/0199e6a0-0000-7000-8000-00000000dead.pdf")).status(),
  ).toBe(403);
});

test("repack a Ready order: its labels are voided, it is back in Packing", async ({ page }) => {
  test.setTimeout(90_000);
  await withShipStation(async () => {
    const token = crypto.randomUUID().slice(0, 8);
    const a = await make({ customerName: `E2E ${token} A`, labels: ["ACTIVE", "ACTIVE"] });
    await signInAs(page, ["SHIPPER"]);
    await readyQueue(page, token);
    await select(page, a);
    await page.getByRole("button", { name: "Repack (1)" }).click();
    const dialog = page.getByRole("dialog", { name: "Repack orders" });
    await expect(dialog.getByRole("alert")).toContainText("will be voided");
    await expect(dialog.getByRole("button", { name: "Void labels and repack" })).toBeDisabled();
    await dialog.getByLabel("Reason").fill("Customer wants another scent");
    await dialog.getByRole("button", { name: "Void labels and repack" }).click();
    await expect(page.getByText("1 order is back in Packing.")).toBeVisible();

    const after = await db.order.findUniqueOrThrow({ where: { id: a.order.id } });
    expect(after.status).toBe("PACKING");
    const labels = await db.shippingLabel.findMany({ where: { id: { in: a.labelIds } } });
    expect(labels.map((l) => l.status)).toEqual(["VOIDED", "VOIDED"]);
    expect(await db.package.count({ where: { orderId: a.order.id } })).toBe(2);

    await page.goto("/queue/packing");
    await page.getByRole("searchbox", { name: "Search orders" }).fill(token);
    await expect(rowOf(page, a)).toBeVisible();
  });
});

test("a rejected void keeps the order in Ready; Retry void is refused by the carrier; an admin writes it off", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await withShipStation(async () => {
    const token = crypto.randomUUID().slice(0, 8);
    // Package 2's void was rejected (VOID-REJECT-2): the state a repack leaves behind.
    const a = await make({
      customerName: `E2E ${token} A`,
      labels: ["VOIDED", "VOID_REJECTED"],
      address2: "VOID-REJECT-2",
    });
    // The shipper sees it but may not write off.
    await signInAs(page, ["SHIPPER"]);
    await page.goto(`/orders/${a.order.id}`);
    const stuck = page.getByTestId("stuck-labels");
    await expect(stuck).toContainText("Package 2");
    await expect(stuck).toContainText("Void rejected");
    await expect(stuck.getByRole("button", { name: "Write off" })).toHaveCount(0);
    expect((await db.order.findUniqueOrThrow({ where: { id: a.order.id } })).status).toBe("READY");

    // An admin checks with the carrier and writes it off.
    await page.context().clearCookies();
    await signInAs(page, ["ADMIN"]);
    await page.goto(`/orders/${a.order.id}`);
    await page.getByTestId("stuck-labels").getByRole("button", { name: "Write off" }).click();
    const dialog = page.getByRole("dialog", { name: "Write off this label?" });
    await expect(dialog.getByRole("button", { name: "Write off label" })).toBeDisabled();
    await dialog.getByLabel("Reason").fill("Carrier confirmed it shipped");
    await dialog.getByRole("button", { name: "Write off label" }).click();
    await expect(page.getByText("The label was written off.")).toBeVisible();
    await expect(page.getByTestId("stuck-labels")).toHaveCount(0);
    const written = await db.shippingLabel.findUniqueOrThrow({
      where: { id: a.labelIds[1] as string },
    });
    expect(written.status).toBe("WRITTEN_OFF");
    expect(
      await db.auditEvent.count({
        where: { action: "label.writeOff", entityId: a.labelIds[1] as string },
      }),
    ).toBe(1);

    // And the repack now goes through.
    await readyQueue(page, token);
    await select(page, a);
    await page.getByRole("button", { name: "Repack (1)" }).click();
    await page.getByRole("dialog").getByLabel("Reason").fill("Wrong scent");
    await page.getByRole("dialog").getByRole("button", { name: "Void labels and repack" }).click();
    await expect(page.getByText("1 order is back in Packing.")).toBeVisible();
    expect((await db.order.findUniqueOrThrow({ where: { id: a.order.id } })).status).toBe(
      "PACKING",
    );
  });
});

test("a Canadian order in QA shows the international badge and the products lacking customs data until they have it", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const qa = await signInAs(page, ["QA"]);
  await withSettingsLock(async () => {
    const o = await qaJourneyOrder({ qaUserId: qa.id });
    try {
      await db.order.update({
        where: { id: o.order.id },
        data: {
          shipTo: {
            name: "E2E Customer",
            address1: "1 Main St",
            city: "Toronto",
            state: "ON",
            postalCode: "M5V 2T6",
            country: "CA",
          },
        },
      });
      await page.goto(`/qa/${o.order.id}`);
      await expect(page.getByTestId("international-badge")).toBeVisible();
      await expect(page.getByTestId("customs-missing")).toContainText("E2E item");

      const item = await db.orderItem.findFirstOrThrow({ where: { orderId: o.order.id } });
      await db.product.update({
        where: { id: item.productId as string },
        data: { hsCode: "6117.10", countryOfOrigin: "PE" },
      });
      await page.reload();
      await expect(page.getByTestId("international-badge")).toBeVisible();
      await expect(page.getByTestId("customs-missing")).toHaveCount(0);
    } finally {
      await o.cleanup();
    }
  });
});

test("Push errors: an admin sees a failed push on Sync and retries it; a shipper has no Sync", async ({
  page,
}) => {
  const token = crypto.randomUUID().slice(0, 8);
  const a = await make({ customerName: `E2E ${token} A`, status: "COMPLETED" });
  await db.order.update({
    where: { id: a.order.id },
    data: { wooPushStatus: "FAILED", wooPushError: "errors.sync.unauthorized", wooPushAttempts: 3 },
  });
  await signInAs(page, ["ADMIN"]);
  await page.goto("/sync");
  const errors = page.getByTestId("push-errors");
  const row = errors.getByRole("row", { name: new RegExp(`#?${a.order.number}`) });
  await expect(row).toBeVisible();
  const box = page.getByRole("checkbox", { name: `Select order ${a.order.number}` });
  await page.locator("label", { has: box }).click();
  await errors.getByRole("button", { name: "Retry selected" }).click();
  await expect(page.getByText("1 order queued to retry.")).toBeVisible();
  await expect
    .poll(
      async () => (await db.order.findUniqueOrThrow({ where: { id: a.order.id } })).wooPushStatus,
    )
    .toBe("PENDING");
  await expect(row).toHaveCount(0);

  // Back to FAILED, and the order page offers the admin Retry too.
  await db.order.update({ where: { id: a.order.id }, data: { wooPushStatus: "FAILED" } });
  await page.goto(`/orders/${a.order.id}`);
  await expect(page.getByText("Woo update failed")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();

  await page.context().clearCookies();
  await signInAs(page, ["SHIPPER"]);
  await page.goto(`/orders/${a.order.id}`);
  await expect(page.getByText("Woo update failed")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  await page.goto("/sync");
  await expect(page.getByText("You don't have permission to do that.")).toBeVisible();
});

test("a manifest is created for today's shipped labels and its PDF opens", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "one manifest per carrier and day");
  test.setTimeout(90_000);
  await withSettingsLock(async () => {
    const restore = await enableShipStation();
    const carrierName = `E2E Manifest ${crypto.randomUUID().slice(0, 8)}`;
    const carrier = await db.shippingCarrier.create({
      data: {
        provider: "SHIPSTATION",
        externalId: `se-e2e-${crypto.randomUUID()}`,
        code: "demo_ground",
        name: carrierName,
        enabled: true,
      },
    });
    const a = await make({ status: "COMPLETED", labels: ["ACTIVE", "ACTIVE"] });
    await db.shippingLabel.updateMany({
      where: { id: { in: a.labelIds } },
      data: { carrierId: carrier.id },
    });
    try {
      await signInAs(page, ["SHIPPER"]);
      await page.goto("/orders");
      await openNav(page);
      await page.getByRole("navigation").getByRole("link", { name: "Manifests" }).click();
      const card = page.getByRole("listitem").filter({ hasText: carrierName }).first();
      await expect(card).toContainText("2 labels not manifested");
      await card.getByRole("button", { name: "Create manifest" }).click();
      await expect(page.getByText("Manifest created for 2 labels.")).toBeVisible();
      await expect(card).toContainText("No labels not manifested");

      const manifest = await db.manifest.findFirstOrThrow({ where: { carrierId: carrier.id } });
      expect(await db.shippingLabel.count({ where: { manifestId: manifest.id } })).toBe(2);
      const pdf = await page.request.get(`/api/manifests/${manifest.id}.pdf`);
      expect(pdf.status()).toBe(200);
      expect(pdf.headers()["content-type"]).toContain("application/pdf");
    } finally {
      await db.shippingLabel.updateMany({
        where: { id: { in: a.labelIds } },
        data: { manifestId: null },
      });
      await db.manifest.deleteMany({ where: { carrierId: carrier.id } });
      await a.cleanup();
      await db.order.deleteMany({ where: { id: a.order.id } });
      made.splice(made.indexOf(a), 1);
      await db.shippingCarrier.delete({ where: { id: carrier.id } });
      await restore();
    }
  });
});

test("the tracking switch is refused while the store can't be reached, then allowed once it has the plugin", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "global settings");
  test.setTimeout(90_000);
  const key = encryptionKey();
  test.skip(!key, "SETTINGS_ENCRYPTION_KEY is not set");
  await withSettingsLock(async () => {
    const before = await db.settings.findUnique({ where: { id: 1 } });
    const point = (url: string) =>
      db.settings.upsert({
        where: { id: 1 },
        create: { id: 1 },
        update: {
          wooStoreUrl: url,
          wooConsumerKeyEnc: encryptSecret(process.env.WOO_CONSUMER_KEY ?? "ck_dev", key as Buffer),
          wooConsumerSecretEnc: encryptSecret(
            process.env.WOO_CONSUMER_SECRET ?? "cs_dev",
            key as Buffer,
          ),
          wooTrackingEnabled: false,
        },
      });
    try {
      await signInAs(page, ["ADMIN"]);
      await point("http://127.0.0.1:1");
      await page.goto("/settings");
      const woo = page.getByRole("region", { name: "WooCommerce" });
      const toggle = page.getByRole("switch", { name: /Advanced Shipment Tracking/ });
      await page.locator("label", { has: toggle }).click();
      await expect(woo.getByRole("alert")).toBeVisible();
      expect((await db.settings.findUniqueOrThrow({ where: { id: 1 } })).wooTrackingEnabled).toBe(
        false,
      );

      // Only the dev WooCommerce with the plugin installed (docker/wordpress/setup.sh) lets it through.
      const dev = process.env.WOO_URL ?? "http://localhost:8090";
      const hasPlugin = await fetch(`${dev}/wp-json/wc-shipment-tracking/v3`, {
        headers: {
          authorization: `Basic ${Buffer.from(`${process.env.WOO_CONSUMER_KEY}:${process.env.WOO_CONSUMER_SECRET}`).toString("base64")}`,
        },
      })
        .then((r) => r.ok)
        .catch(() => false);
      if (!hasPlugin) return;
      await point(dev);
      await page.reload();
      await page.locator("label", { has: toggle }).click();
      await expect
        .poll(
          async () =>
            (await db.settings.findUniqueOrThrow({ where: { id: 1 } })).wooTrackingEnabled,
        )
        .toBe(true);
      expect(
        await db.auditEvent.count({ where: { entityType: "Settings", action: "update" } }),
      ).toBeGreaterThan(0);
      // Off is always allowed, even with the store gone.
      await point("http://127.0.0.1:1");
      await db.settings.update({ where: { id: 1 }, data: { wooTrackingEnabled: true } });
      await page.reload();
      await page.locator("label", { has: toggle }).click();
      await expect
        .poll(
          async () =>
            (await db.settings.findUniqueOrThrow({ where: { id: 1 } })).wooTrackingEnabled,
        )
        .toBe(false);
    } finally {
      await db.settings.update({
        where: { id: 1 },
        data: {
          wooStoreUrl: before?.wooStoreUrl ?? null,
          wooConsumerKeyEnc: before?.wooConsumerKeyEnc ?? null,
          wooConsumerSecretEnc: before?.wooConsumerSecretEnc ?? null,
          wooTrackingEnabled: before?.wooTrackingEnabled ?? false,
        },
      });
    }
  });
});
