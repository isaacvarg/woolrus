import { expect, test } from "@playwright/test";
import { createDb } from "@woolrus/db";
import { signInAs } from "./support/auth";

// A Rate Lab run's page (SPEC-rate-lab "Run detail", the ticket's e2e): two finished suite runs are
// seeded straight into the quote log, on carriers of their own (off, so nothing else quotes them).

const db = createDb();
const prefix = `E2E run ${crypto.randomUUID().slice(0, 8)}`;
const runIds: string[] = [];
const carrierIds: string[] = [];

test.afterAll(async () => {
  await db.rateLabRun.deleteMany({ where: { id: { in: runIds } } });
  await db.rateLabAddress.deleteMany({ where: { title: { startsWith: prefix } } });
  await db.rateLabParcel.deleteMany({ where: { title: { startsWith: prefix } } });
  await db.carrierService.deleteMany({ where: { carrierId: { in: carrierIds } } });
  await db.shippingCarrier.deleteMany({ where: { id: { in: carrierIds } } });
});

async function carrier(
  provider: "SHIPSTATION" | "BRIDGE_SOURCE",
  name: string,
  services: string[],
) {
  const created = await db.shippingCarrier.create({
    data: {
      provider,
      externalId: `${prefix} ${name}`,
      code: name.toLowerCase(),
      name: `${prefix} ${name}`,
      enabled: false,
      services: {
        create: services.map((service) => ({
          code: service.toLowerCase(),
          name: service,
          domestic: true,
          international: false,
          enabled: false,
        })),
      },
    },
    include: { services: { orderBy: { name: "asc" } } },
  });
  carrierIds.push(created.id);
  return created;
}

test("a Rate Lab user opens a finished run, sees the insight cards and filters the quotes", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop", "Rate Lab users are on desktops (assumption 5)");
  const demo = await carrier("SHIPSTATION", "Parcelco", ["Express", "Ground"]);
  const bridge = await carrier("BRIDGE_SOURCE", "Bridgeco", ["Saver"]);
  const [express, ground] = demo.services;
  const [saver] = bridge.services;
  if (!express || !ground || !saver) throw new Error("services missing");
  const value = {
    name: "Ada",
    address1: "1 Main St",
    city: "Denver",
    state: "CO",
    postalCode: "80202",
    country: "US",
  };
  const address = await db.rateLabAddress.create({
    data: {
      title: `${prefix} Denver`,
      original: value,
      address: value,
      residential: true,
      checkStatus: "VERIFIED",
    },
  });
  const small = await db.rateLabParcel.create({
    data: { title: `${prefix} Small`, lengthIn: 8, widthIn: 6, heightIn: 4, weightOz: 16 },
  });
  const large = await db.rateLabParcel.create({
    data: { title: `${prefix} Large`, lengthIn: 16, widthIn: 12, heightIn: 8, weightOz: 80 },
  });

  type Price = { service: typeof ground; cents: number; days: number; quoteOnly?: boolean };
  const run = async (
    createdAt: Date,
    fetches: { parcelId: string; prices: Price[]; failed?: boolean }[],
  ) => {
    const created = await db.rateLabRun.create({
      data: {
        kind: "SUITE",
        status: "PARTIAL",
        selection: {
          addressGroupIds: [],
          addressIds: [address.id],
          parcelGroupIds: [],
          parcelIds: [],
        },
        shipFrom: value,
        combinations: fetches.length,
        completedCombinations: fetches.length,
        createdAt,
        startedAt: createdAt,
        finishedAt: new Date(createdAt.getTime() + 42_000),
        fake: true,
      },
    });
    runIds.push(created.id);
    for (const { parcelId, prices, failed } of fetches) {
      await db.rateFetch.create({
        data: {
          source: "LAB",
          trigger: "LAB_RUN",
          labRunId: created.id,
          labAddressId: address.id,
          labParcelId: parcelId,
          destCountry: "US",
          destState: "CO",
          residential: true,
          international: false,
          lengthIn: 8,
          widthIn: 6,
          heightIn: 4,
          weightOz: 16,
          fake: true,
          providerErrors: failed
            ? [{ provider: "BRIDGE_SOURCE", messageKey: "errors.carriers.noCarriers" }]
            : [],
          quotes: {
            create: prices.map(({ service, cents, days, quoteOnly }) => ({
              provider: service.carrierId === bridge.id ? "BRIDGE_SOURCE" : "SHIPSTATION",
              carrierId: service.carrierId,
              serviceId: service.id,
              carrierCode: "e2e",
              serviceCode: service.code,
              serviceName: service.name,
              amountCents: cents,
              currency: "USD",
              deliveryDays: days,
              guaranteed: false,
              quoteOnly: quoteOnly ?? false,
              cheapest: false,
              fake: true,
            })),
          },
        },
      });
    }
    return created;
  };

  // An earlier run in the past, then the one under test: Ground on Small went up 20%.
  const day = 24 * 60 * 60 * 1000;
  await run(new Date(Date.now() - 8 * day), [
    { parcelId: small.id, prices: [{ service: ground, cents: 1000, days: 5 }] },
  ]);
  const current = await run(new Date(Date.now() - day), [
    {
      parcelId: small.id,
      prices: [
        { service: ground, cents: 1200, days: 5 },
        { service: express, cents: 2500, days: 1 },
        { service: saver, cents: 900, days: 6, quoteOnly: true },
      ],
    },
    { parcelId: large.id, prices: [{ service: ground, cents: 1800, days: 5 }], failed: true },
  ]);

  await signInAs(page, ["QA", "RATE_LAB"]);
  await page.goto(`/rate-lab/runs/${current.id}`);
  await expect(page.getByRole("heading", { name: /^Run of / })).toBeVisible();
  await expect(page.getByText("Partial", { exact: true })).toBeVisible();

  const picks = page.getByRole("table", { name: "Cheapest and fastest" });
  const smallPick = picks.getByRole("row").filter({ hasText: `${prefix} Small` });
  // The quote-only Saver is cheaper, but Ground can be bought.
  await expect(smallPick.getByRole("cell").nth(1)).toContainText("Ground: $12.00");
  await expect(smallPick.getByRole("cell").nth(2)).toContainText("Express: $25.00");

  const moves = page.getByTestId("lab-price-move");
  await expect(moves.filter({ hasText: "Ground" })).toContainText("+20%");
  await expect(moves.filter({ hasText: "Express" })).toContainText("New");

  await expect(page.getByRole("table", { name: "Carrier wins" })).toContainText(
    `${prefix} Parcelco Ground`,
  );
  await expect(page.getByText("Bridge Source: 1 error")).toBeVisible();

  const quotes = page.getByTestId("lab-quote-row");
  await expect(quotes).toHaveCount(4);
  await expect(quotes.filter({ hasText: "Saver" })).toContainText("Quote only");
  await expect(quotes.filter({ hasText: "Express" })).toContainText("Fastest");

  await page.getByRole("button", { name: /Carrier/ }).click();
  await page.getByRole("option", { name: `${prefix} Bridgeco` }).click();
  await expect(quotes).toHaveCount(1);
  await expect(quotes).toContainText("Saver");

  await page.getByRole("button", { name: /Carrier/ }).click();
  await page.getByRole("option", { name: "All" }).click();
  await page.getByRole("button", { name: /Status/ }).click();
  await page.getByRole("option", { name: "Error" }).click();
  await expect(quotes).toHaveCount(0);
  await expect(page.getByTestId("lab-error-row")).toHaveCount(1);
});
