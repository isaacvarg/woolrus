import { expect, test } from "@playwright/test";
import { createDb } from "@woolrus/db";
import { signInAs } from "./support/auth";
import { demoService } from "./support/qa";

// Rate Lab → Trends (SPEC-rate-lab criterion 12, the ticket's e2e): two suite runs over two test
// addresses × two parcels are seeded straight into the quote log, in their own groups so other
// tests' addresses and parcels stay out of the filtered heatmap.

const db = createDb();
const prefix = `E2E trends ${crypto.randomUUID().slice(0, 8)}`;
const runIds: string[] = [];

test.afterAll(async () => {
  // Runs first: their fetches hold the addresses and parcels (Restrict).
  await db.rateLabRun.deleteMany({ where: { id: { in: runIds } } });
  await db.rateLabAddress.deleteMany({ where: { title: { startsWith: prefix } } });
  await db.rateLabParcel.deleteMany({ where: { title: { startsWith: prefix } } });
  await db.rateLabGroup.deleteMany({ where: { name: { startsWith: prefix } } });
});

const shipAddress = {
  name: "E2E Trends",
  address1: "1 Main St",
  city: "Austin",
  state: "TX",
  postalCode: "78701",
  country: "US",
};

test("Trends shows a cell per combination, and a cell opens its chart", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Rate Lab users are on desktops (assumption 5)");
  const { carrier, service } = await demoService();
  const addressGroup = await db.rateLabGroup.create({
    data: { kind: "ADDRESS", name: `${prefix} addresses` },
  });
  const parcelGroup = await db.rateLabGroup.create({
    data: { kind: "PARCEL", name: `${prefix} parcels` },
  });
  const addresses = await Promise.all(
    ["Ranch", "City"].map((name) =>
      db.rateLabAddress.create({
        data: {
          title: `${prefix} ${name}`,
          original: shipAddress,
          address: shipAddress,
          residential: true,
          checkStatus: "VERIFIED",
          groups: { create: { groupId: addressGroup.id } },
        },
      }),
    ),
  );
  const parcels = await Promise.all(
    ["Box", "Tube"].map((name) =>
      db.rateLabParcel.create({
        data: {
          title: `${prefix} ${name}`,
          lengthIn: 10,
          widthIn: 8,
          heightIn: 4,
          weightOz: 16,
          groups: { create: { groupId: parcelGroup.id } },
        },
      }),
    ),
  );
  // Week one at $10.00 for every combination, week two at $11.00 (+10%).
  for (const [week, amountCents] of [
    [2, 1000],
    [1, 1100],
  ] as const) {
    const at = new Date(Date.now() - week * 7 * 24 * 60 * 60 * 1000);
    const run = await db.rateLabRun.create({
      data: {
        kind: "SUITE",
        status: "SUCCEEDED",
        selection: {},
        shipFrom: shipAddress,
        combinations: 4,
        completedCombinations: 4,
        quoteCount: 4,
        startedAt: at,
        finishedAt: at,
      },
    });
    runIds.push(run.id);
    for (const address of addresses) {
      for (const parcel of parcels) {
        await db.rateFetch.create({
          data: {
            source: "LAB",
            trigger: "LAB_RUN",
            labRunId: run.id,
            labAddressId: address.id,
            labParcelId: parcel.id,
            destCountry: "US",
            destState: "TX",
            residential: true,
            international: false,
            lengthIn: 10,
            widthIn: 8,
            heightIn: 4,
            weightOz: 16,
            fake: false,
            fetchedAt: at,
            quotes: {
              create: {
                provider: "SHIPSTATION",
                carrierId: carrier.id,
                serviceId: service.id,
                carrierCode: "demo_ground",
                serviceCode: "demo_ground",
                serviceName: "Demo Ground",
                amountCents,
                currency: "USD",
                deliveryDays: 3,
                guaranteed: false,
                quoteOnly: false,
                cheapest: true,
                fake: false,
              },
            },
          },
        });
      }
    }
  }

  await signInAs(page, ["RATE_LAB"]);
  await page.goto("/rate-lab/runs");
  await page
    .getByRole("navigation", { name: "Rate Lab sections" })
    .getByRole("link", { name: "Trends" })
    .click();
  await expect(page).toHaveURL("/rate-lab/trends");

  // Only this test's groups, so other tests' addresses and parcels stay out of the heatmap.
  for (const name of [addressGroup.name, parcelGroup.name]) {
    const box = page.getByRole("checkbox", { name });
    await page.locator("label", { has: box }).click();
    await expect(box).toBeChecked();
  }

  const heatmap = page.getByRole("table", { name: "Cheapest price by address and parcel" });
  await expect(heatmap.getByRole("columnheader", { name: `${prefix} Box` })).toBeVisible();
  await expect(heatmap.getByRole("columnheader", { name: `${prefix} Tube` })).toBeVisible();
  // A header row plus one row per address, each with a cell per parcel.
  await expect(heatmap.getByRole("row")).toHaveCount(3);
  for (const address of addresses) {
    const row = heatmap.getByRole("row", { name: new RegExp(address.title) });
    await expect(row.getByRole("cell")).toHaveCount(2);
    for (const cell of await row.getByRole("cell").all()) {
      await expect(cell).toContainText("$11.00");
      await expect(cell).toContainText("+10%");
    }
  }

  await heatmap
    .getByRole("row", { name: new RegExp(`${prefix} Ranch`) })
    .getByRole("button")
    .first()
    .click();
  const chart = page.getByRole("figure", { name: `${prefix} Ranch × ${prefix} Box` });
  await expect(chart).toBeVisible();
  await expect(chart.locator("svg.recharts-surface").first()).toBeVisible();
  await chart.getByRole("button", { name: "Show the data" }).click();
  const rows = chart.getByRole("table").getByRole("row");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(1)).toContainText("$10.00");
  await expect(rows.nth(2)).toContainText("$11.00");
});
