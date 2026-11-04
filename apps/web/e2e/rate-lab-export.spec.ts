import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { createDb } from "@woolrus/db";
import { signInAs } from "./support/auth";

// Rate Lab's CSV export (SPEC-rate-lab "Exports", the ticket's e2e): Export CSV on a run's page
// delivers a download, and the Real orders export refuses a Rate Lab user without `report.read`.

const db = createDb();
const prefix = `E2E export ${crypto.randomUUID().slice(0, 8)}`;
const runIds: string[] = [];
const carrierIds: string[] = [];

test.afterAll(async () => {
  await db.rateLabRun.deleteMany({ where: { id: { in: runIds } } });
  await db.rateLabAddress.deleteMany({ where: { title: { startsWith: `=${prefix}` } } });
  await db.rateLabParcel.deleteMany({ where: { title: { startsWith: prefix } } });
  await db.carrierService.deleteMany({ where: { carrierId: { in: carrierIds } } });
  await db.shippingCarrier.deleteMany({ where: { id: { in: carrierIds } } });
});

test("Export CSV on a run downloads its quotes", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Rate Lab users are on desktops (assumption 5)");
  // Off, so nothing else quotes it.
  const carrier = await db.shippingCarrier.create({
    data: {
      provider: "SHIPSTATION",
      externalId: `${prefix} Parcelco`,
      code: "parcelco",
      name: `${prefix} Parcelco`,
      enabled: false,
      services: {
        create: { code: "ground", name: "Ground", domestic: true, international: false },
      },
    },
    include: { services: true },
  });
  carrierIds.push(carrier.id);
  const [ground] = carrier.services;
  if (!ground) throw new Error("service missing");
  const value = {
    name: "Ada",
    address1: "1 Main St",
    city: "Denver",
    state: "CO",
    postalCode: "80202",
    country: "US",
  };
  // A title a spreadsheet would run as a formula.
  const address = await db.rateLabAddress.create({
    data: {
      title: `=${prefix} Denver`,
      original: value,
      address: value,
      residential: true,
      checkStatus: "VERIFIED",
    },
  });
  const parcel = await db.rateLabParcel.create({
    data: { title: `${prefix} Small`, lengthIn: 8, widthIn: 6, heightIn: 4, weightOz: 16 },
  });
  const at = new Date(Date.now() - 60_000);
  const run = await db.rateLabRun.create({
    data: {
      kind: "SUITE",
      status: "SUCCEEDED",
      selection: {
        addressGroupIds: [],
        addressIds: [address.id],
        parcelGroupIds: [],
        parcelIds: [],
      },
      shipFrom: value,
      combinations: 1,
      completedCombinations: 1,
      createdAt: at,
      startedAt: at,
      finishedAt: new Date(at.getTime() + 5_000),
      fake: true,
      fetches: {
        create: {
          source: "LAB",
          trigger: "LAB_RUN",
          labAddressId: address.id,
          labParcelId: parcel.id,
          destCountry: "US",
          destState: "CO",
          residential: true,
          international: false,
          lengthIn: 8,
          widthIn: 6,
          heightIn: 4,
          weightOz: 16,
          fake: true,
          quotes: {
            create: {
              provider: "SHIPSTATION",
              carrierId: carrier.id,
              serviceId: ground.id,
              carrierCode: "e2e",
              serviceCode: ground.code,
              serviceName: ground.name,
              amountCents: 1234,
              currency: "USD",
              deliveryDays: 3,
              guaranteed: false,
              quoteOnly: false,
              cheapest: false,
              fake: true,
            },
          },
        },
      },
    },
  });
  runIds.push(run.id);

  await signInAs(page, ["RATE_LAB"]);
  await page.goto(`/rate-lab/runs/${run.id}`);
  await expect(page.getByRole("heading", { name: /^Run of / })).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "Export CSV" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^rate-lab-run-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\.csv$/);
  const path = await download.path();
  const text = (await readFile(path)).toString("utf8");
  expect(text.startsWith("﻿Run,Address,Parcel,Provider,")).toBe(true);
  expect(text).toContain(
    `${run.id},'=${prefix} Denver,${prefix} Small,SHIPSTATION,${prefix} Parcelco,Ground,12.34,USD,3,yes,,\r\n`,
  );

  // A Rate Lab user can't read Real orders, so can't export them either.
  const refused = await page.request.get("/api/rate-lab/real-orders/export.csv");
  expect(refused.status()).toBe(403);
});
