import { expect, type Page, test } from "@playwright/test";
import { createDb } from "@woolrus/db";
import { signInAs } from "./support/auth";

// Rate Lab's print-ready reports (SPEC-rate-lab "Exports", criterion 17): the run report in print
// media has no app nav and nothing wider than the page, and each report page needs the same
// permission as its screen. Runs are seeded straight into the quote log, on a carrier of their own.

const db = createDb();
const prefix = `E2E report ${crypto.randomUUID().slice(0, 8)}`;
const runIds: string[] = [];
const carrierIds: string[] = [];

/** A4's printable width at 96 dpi with 10 mm margins (190 mm); Letter's is wider. */
const PRINT_WIDTH = 718;

test.afterAll(async () => {
  await db.rateLabRun.deleteMany({ where: { id: { in: runIds } } });
  await db.rateLabAddress.deleteMany({ where: { title: { startsWith: prefix } } });
  await db.rateLabParcel.deleteMany({ where: { title: { startsWith: prefix } } });
  await db.carrierService.deleteMany({ where: { carrierId: { in: carrierIds } } });
  await db.shippingCarrier.deleteMany({ where: { id: { in: carrierIds } } });
});

const value = {
  name: "Ada",
  address1: "1 Main St",
  city: "Denver",
  state: "CO",
  postalCode: "80202",
  country: "US",
};

/** Two suite runs of one address × parcel a week apart; returns the later one. */
async function seedRuns() {
  const tag = crypto.randomUUID().slice(0, 4);
  const carrier = await db.shippingCarrier.create({
    data: {
      provider: "SHIPSTATION",
      externalId: `${prefix} Parcelco ${tag}`,
      code: "parcelco",
      name: `${prefix} Parcelco`,
      enabled: false,
      services: {
        create: ["Express", "Ground"].map((name) => ({
          code: name.toLowerCase(),
          name,
          domestic: true,
          international: false,
          enabled: false,
        })),
      },
    },
    include: { services: { orderBy: { name: "asc" } } },
  });
  carrierIds.push(carrier.id);
  const [express, ground] = carrier.services;
  if (!express || !ground) throw new Error("services missing");
  const address = await db.rateLabAddress.create({
    data: {
      title: `${prefix} Denver ${tag}`,
      original: value,
      address: value,
      residential: true,
      checkStatus: "VERIFIED",
    },
  });
  const parcel = await db.rateLabParcel.create({
    data: { title: `${prefix} Small ${tag}`, lengthIn: 8, widthIn: 6, heightIn: 4, weightOz: 16 },
  });

  const run = async (startedAt: Date, prices: [typeof ground, number][]) => {
    const created = await db.rateLabRun.create({
      data: {
        kind: "SUITE",
        status: "SUCCEEDED",
        selection: { addressGroupIds: [], addressIds: [], parcelGroupIds: [], parcelIds: [] },
        shipFrom: value,
        combinations: 1,
        completedCombinations: 1,
        createdAt: startedAt,
        startedAt,
        finishedAt: new Date(startedAt.getTime() + 30_000),
        fake: true,
      },
    });
    runIds.push(created.id);
    await db.rateFetch.create({
      data: {
        source: "LAB",
        trigger: "LAB_RUN",
        labRunId: created.id,
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
          create: prices.map(([service, cents]) => ({
            provider: "SHIPSTATION",
            carrierId: carrier.id,
            serviceId: service.id,
            carrierCode: "e2e",
            serviceCode: service.code,
            serviceName: service.name,
            amountCents: cents,
            currency: "USD",
            deliveryDays: service === express ? 1 : 5,
            guaranteed: false,
            quoteOnly: false,
            cheapest: false,
            fake: true,
          })),
        },
      },
    });
    return created;
  };

  const day = 24 * 60 * 60 * 1000;
  await run(new Date(Date.now() - 8 * day), [[ground, 1000]]);
  return run(new Date(Date.now() - day), [
    [ground, 1200],
    [express, 2500],
  ]);
}

/** The report pages print themselves when asked; tests never open the dialog. */
async function stubPrint(page: Page) {
  await page.addInitScript(() => {
    window.print = () => {
      (window as unknown as { printed: number }).printed =
        ((window as unknown as { printed?: number }).printed ?? 0) + 1;
    };
  });
}

test("the run report opens from the run page and prints with no nav, within the page width", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop", "Rate Lab users are on desktops (assumption 5)");
  const current = await seedRuns();
  await stubPrint(page);
  await signInAs(page, ["QA", "RATE_LAB"]);

  await page.goto(`/rate-lab/runs/${current.id}`);
  const link = page.getByRole("link", { name: "PDF report" });
  await expect(link).toHaveAttribute("href", `/rate-lab/runs/${current.id}/report?print=1`);
  await expect(link).toHaveAttribute("target", "_blank");

  await page.setViewportSize({ width: PRINT_WIDTH, height: 1000 });
  await page.emulateMedia({ media: "print" });
  await page.goto(`/rate-lab/runs/${current.id}/report?print=1`);
  await expect(page.getByRole("heading", { name: "Rate Lab run report" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^Run of / })).toBeVisible();
  await expect(page.getByRole("table", { name: "Cheapest and fastest" })).toContainText(
    "Ground: $12.00",
  );
  // The trend card covers both suite runs; the quote table has every quote and no filters.
  await expect(page.getByText("2 runs: latest $12.00, low $10.00, high $12.00")).toBeVisible();
  await expect(page.getByTestId("lab-quote-row")).toHaveCount(2);
  await expect(page.getByRole("button", { name: /Carrier/ })).toHaveCount(0);
  // print=1 calls the print dialog once the report has loaded.
  await expect.poll(() => page.evaluate(() => (window as { printed?: number }).printed)).toBe(1);

  // No app nav, and the print button itself is hidden in print.
  await expect(page.getByRole("link", { name: "Boxes" })).toHaveCount(0);
  await expect(page.locator(".drawer-side")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Print or save as PDF" })).toBeHidden();
  const overflow = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const wide = [...document.querySelectorAll("body *")].filter(
      (el) => el.getBoundingClientRect().right > width + 1,
    );
    return { scroll: document.documentElement.scrollWidth, width, wide: wide.length };
  });
  expect(overflow.scroll).toBeLessThanOrEqual(overflow.width);
  expect(overflow.wide).toBe(0);
});

test("each report page needs its screen's permission", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "Rate Lab users are on desktops (assumption 5)");
  const current = await seedRuns();
  const pageAs = async (roles: Parameters<typeof signInAs>[1]) => {
    const page = await (await browser.newContext()).newPage();
    await signInAs(page, roles);
    return page;
  };
  const forbidden = (page: Page) =>
    expect(page.getByRole("alert").filter({ hasText: "You don't have permission" })).toBeVisible();

  // Without the Rate Lab role: no report at all.
  const shipper = await pageAs(["SHIPPER", "QA"]);
  for (const path of [
    `/rate-lab/runs/${current.id}/report`,
    "/rate-lab/trends/report",
    "/rate-lab/real-orders/report",
  ]) {
    await shipper.goto(path);
    await forbidden(shipper);
  }

  // The Rate Lab role: the run and Trends reports, but not Real orders (report.read).
  const lab = await pageAs(["RATE_LAB"]);
  await lab.goto(`/rate-lab/runs/${current.id}/report`);
  await expect(lab.getByRole("heading", { name: "Rate Lab run report" })).toBeVisible();
  await lab.goto("/rate-lab/trends/report?includeFake=1");
  await expect(lab.getByRole("heading", { name: "Rate Lab trends report" })).toBeVisible();
  await expect(
    lab.getByRole("table", { name: "Cheapest price by address and parcel" }),
  ).toContainText(`${prefix} Small`);
  await lab.goto("/rate-lab/real-orders/report");
  await forbidden(lab);

  // An admin has both.
  const admin = await pageAs(["ADMIN"]);
  await admin.goto("/rate-lab/real-orders/report");
  await expect(admin.getByRole("heading", { name: "Rate Lab real orders report" })).toBeVisible();
  await expect(admin.getByText("You don't have permission")).toHaveCount(0);
});
