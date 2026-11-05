import type { Db, Prisma } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { labRunTrends, labTrendGrid, labTrendSeries, labTrendsReport } from "./trends";

// SPEC-rate-lab "Trends" (criteria 10, 12): the heatmap's latest cell and change, and the series
// points, over seeded suite runs. Also the print reports' reads ("Exports").

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

type Service = { id: string; carrierId: string; code: string; name: string };

async function carrier(name: string, label: string | null, codes: string[]) {
  const row = await db.shippingCarrier.create({
    data: {
      provider: "SHIPSTATION",
      externalId: `se-${name}`,
      code: name.toLowerCase(),
      name,
      label,
      enabled: true,
    },
  });
  const services: Service[] = [];
  for (const code of codes) {
    services.push(
      await db.carrierService.create({
        data: {
          carrierId: row.id,
          code,
          name: code.toUpperCase(),
          domestic: true,
          international: false,
          enabled: true,
        },
      }),
    );
  }
  return { carrier: row, services };
}

const shipAddress = {
  name: "Test",
  address1: "1 Main St",
  city: "Austin",
  state: "TX",
  postalCode: "78701",
  country: "US",
};

async function address(title: string, groupIds: string[] = []) {
  return db.rateLabAddress.create({
    data: {
      title,
      original: shipAddress,
      address: shipAddress,
      residential: true,
      checkStatus: "VERIFIED",
      groups: { create: groupIds.map((groupId) => ({ groupId })) },
    },
  });
}

async function parcel(title: string, groupIds: string[] = []) {
  return db.rateLabParcel.create({
    data: {
      title,
      lengthIn: 10,
      widthIn: 8,
      heightIn: 4,
      weightOz: 16,
      groups: { create: groupIds.map((groupId) => ({ groupId })) },
    },
  });
}

async function run(startedAt: string, kind: "SUITE" | "ONE_OFF" = "SUITE") {
  return db.rateLabRun.create({
    data: {
      kind,
      status: "SUCCEEDED",
      selection: {},
      shipFrom: shipAddress,
      combinations: 1,
      startedAt: new Date(startedAt),
      finishedAt: new Date(startedAt),
    },
  });
}

/** One combination's fetch in a run, with its quotes. */
async function fetch(
  runId: string,
  addressId: string,
  parcelId: string,
  quotes: { service: Service; amountCents: number; quoteOnly?: boolean; deliveryDays?: number }[],
  options: { fake?: boolean } = {},
) {
  const fake = options.fake ?? false;
  return db.rateFetch.create({
    data: {
      source: "LAB",
      trigger: "LAB_RUN",
      labRunId: runId,
      labAddressId: addressId,
      labParcelId: parcelId,
      destCountry: "US",
      destState: "TX",
      residential: true,
      international: false,
      lengthIn: 10,
      widthIn: 8,
      heightIn: 4,
      weightOz: 16,
      fake,
      quotes: {
        create: quotes.map((q, i) => ({
          provider: "SHIPSTATION",
          carrierId: q.service.carrierId,
          serviceId: q.service.id,
          carrierCode: "c",
          serviceCode: q.service.code,
          serviceName: q.service.name,
          amountCents: q.amountCents,
          currency: "USD",
          deliveryDays: q.deliveryDays ?? null,
          guaranteed: false,
          quoteOnly: q.quoteOnly ?? false,
          cheapest: i === 0,
          fake,
        })) satisfies Prisma.RateQuoteCreateManyFetchInput[],
      },
    },
  });
}

async function seed() {
  const ups = await carrier("UPS", "UPS main", ["ups_ground"]);
  const usps = await carrier("USPS", null, ["usps_ga", "usps_priority"]);
  const [ground] = ups.services as [Service];
  const [ga, priority] = usps.services as [Service, Service];
  const west = await db.rateLabGroup.create({ data: { kind: "ADDRESS", name: "West" } });
  const small = await db.rateLabGroup.create({ data: { kind: "PARCEL", name: "Small" } });
  const ranch = await address("Rural ranch", [west.id]);
  const city = await address("City flat");
  const box = await parcel("Medium box", [small.id]);
  const tube = await parcel("Poster tube");

  const r1 = await run("2026-10-01T10:00:00Z");
  const r2 = await run("2026-10-08T10:00:00Z");
  const r3 = await run("2026-10-15T10:00:00Z");
  // Ranch × box: 1000 → 1100 → 990 cheapest; USPS GA quote-only in run 3 at 900.
  await fetch(r1.id, ranch.id, box.id, [
    { service: ground, amountCents: 1000, deliveryDays: 4 },
    { service: priority, amountCents: 1500, deliveryDays: 2 },
  ]);
  await fetch(r2.id, ranch.id, box.id, [
    { service: ground, amountCents: 1200, deliveryDays: 4 },
    { service: ga, amountCents: 1100, deliveryDays: 5 },
    { service: priority, amountCents: 1600, deliveryDays: 2 },
  ]);
  await fetch(r3.id, ranch.id, box.id, [
    { service: ga, amountCents: 900, quoteOnly: true, deliveryDays: 5 },
    { service: ground, amountCents: 990, deliveryDays: 4 },
    { service: priority, amountCents: 1650, deliveryDays: 2 },
  ]);
  // City × box: one run only.
  await fetch(r3.id, city.id, box.id, [{ service: ground, amountCents: 800 }]);
  // Ranch × tube: run 2, then a failed combination (no quotes) in run 3.
  await fetch(r2.id, ranch.id, tube.id, [{ service: ga, amountCents: 700 }]);
  await fetch(r3.id, ranch.id, tube.id, []);

  return { ground, ga, priority, ups, usps, west, small, ranch, city, box, tube, r1, r2, r3 };
}

const cellOf = (grid: Awaited<ReturnType<typeof labTrendGrid>>, a: string, p: string) =>
  grid.cells.find((c) => c.addressId === a && c.parcelId === p);

describe("labTrendGrid", () => {
  it("gives every active combination its latest cheapest price and change", async () => {
    const s = await seed();
    const actor = await createActor(db, ["RATE_LAB"]);
    const grid = await labTrendGrid(db, actor, {});

    expect(grid.addresses.map((a) => a.title)).toEqual(["City flat", "Rural ranch"]);
    expect(grid.parcels.map((p) => p.title)).toEqual(["Medium box", "Poster tube"]);
    expect(grid.cells).toHaveLength(4);
    expect(grid.carriers).toEqual([
      { id: s.ups.carrier.id, name: "UPS main" },
      { id: s.usps.carrier.id, name: "USPS" },
    ]);

    // Purchasable first: run 3's cheapest is UPS ground at 990, not the quote-only 900.
    const ranchBox = cellOf(grid, s.ranch.id, s.box.id);
    expect(ranchBox?.latest).toMatchObject({
      runId: s.r3.id,
      amountCents: 990,
      carrierName: "UPS main",
      serviceName: "UPS_GROUND",
      quoteOnly: false,
    });
    expect(ranchBox?.previous).toMatchObject({ runId: s.r2.id, amountCents: 1100 });
    expect(ranchBox?.change).toBeCloseTo(-0.1);

    expect(cellOf(grid, s.city.id, s.box.id)).toMatchObject({
      latest: { runId: s.r3.id, amountCents: 800 },
      previous: null,
      change: null,
    });
    // A failed combination doesn't hide the run before it.
    expect(cellOf(grid, s.ranch.id, s.tube.id)).toMatchObject({
      latest: { runId: s.r2.id, amountCents: 700 },
      previous: null,
    });
    expect(cellOf(grid, s.city.id, s.tube.id)).toMatchObject({ latest: null, change: null });
  });

  it("filters by groups, carriers and date range", async () => {
    const s = await seed();
    const actor = await createActor(db, ["ADMIN"]);

    const grouped = await labTrendGrid(db, actor, {
      addressGroupIds: [s.west.id],
      parcelGroupIds: [s.small.id],
    });
    expect(grouped.cells.map((c) => [c.addressId, c.parcelId])).toEqual([[s.ranch.id, s.box.id]]);

    const usps = await labTrendGrid(db, actor, { carrierIds: [s.usps.carrier.id] });
    expect(cellOf(usps, s.ranch.id, s.box.id)).toMatchObject({
      latest: { amountCents: 1650, serviceName: "USPS_PRIORITY" },
      previous: { amountCents: 1100, serviceName: "USPS_GA" },
    });
    // UPS-only combination drops to no data.
    expect(cellOf(usps, s.city.id, s.box.id)?.latest).toBeNull();

    const early = await labTrendGrid(db, actor, { from: "2026-10-01", to: "2026-10-08" });
    expect(cellOf(early, s.ranch.id, s.box.id)).toMatchObject({
      latest: { runId: s.r2.id, amountCents: 1100 },
      previous: { runId: s.r1.id, amountCents: 1000 },
    });
    expect(cellOf(early, s.ranch.id, s.box.id)?.change).toBeCloseTo(0.1);
  });

  it("hides fake data unless asked, and never counts one-off runs", async () => {
    const s = await seed();
    const actor = await createActor(db, ["RATE_LAB"]);
    const fakeRun = await run("2026-10-20T10:00:00Z");
    await fetch(fakeRun.id, s.ranch.id, s.box.id, [{ service: s.ground, amountCents: 50 }], {
      fake: true,
    });
    const oneOff = await run("2026-10-21T10:00:00Z", "ONE_OFF");
    await fetch(oneOff.id, s.ranch.id, s.box.id, [{ service: s.ground, amountCents: 10 }]);

    const real = cellOf(await labTrendGrid(db, actor, {}), s.ranch.id, s.box.id);
    expect(real?.latest).toMatchObject({ runId: s.r3.id, amountCents: 990 });

    const withFake = cellOf(
      await labTrendGrid(db, actor, { includeFake: true }),
      s.ranch.id,
      s.box.id,
    );
    expect(withFake?.latest).toMatchObject({ runId: fakeRun.id, amountCents: 50 });
    expect(withFake?.previous).toMatchObject({ runId: s.r3.id });

    const series = await labTrendSeries(db, actor, {
      addressId: s.ranch.id,
      parcelId: s.box.id,
      includeFake: true,
    });
    expect(series.runs.map((r) => r.runId)).not.toContain(oneOff.id);
  });

  it("drops archived addresses and parcels from the grid", async () => {
    const s = await seed();
    const actor = await createActor(db, ["RATE_LAB"]);
    await db.rateLabAddress.update({ where: { id: s.city.id }, data: { archivedAt: new Date() } });
    await db.rateLabParcel.update({ where: { id: s.tube.id }, data: { archivedAt: new Date() } });

    const grid = await labTrendGrid(db, actor, {});
    expect(grid.addresses.map((a) => a.id)).toEqual([s.ranch.id]);
    expect(grid.parcels.map((p) => p.id)).toEqual([s.box.id]);
    expect(grid.cells).toHaveLength(1);
  });

  it("is allowed for the Rate Lab role and forbidden without it", async () => {
    await expect(
      labTrendGrid(db, await createActor(db, ["PICKER", "RATE_LAB"]), {}),
    ).resolves.toBeTruthy();
    for (const role of ["PICKER", "PACKER", "QA", "SHIPPER"] as const) {
      await expect(labTrendGrid(db, await createActor(db, [role]), {})).rejects.toThrowError(
        "errors.forbidden",
      );
    }
  });
});

describe("labTrendSeries", () => {
  it("gives a line per carrier service with a point per suite run", async () => {
    const s = await seed();
    const actor = await createActor(db, ["RATE_LAB"]);
    const series = await labTrendSeries(db, actor, { addressId: s.ranch.id, parcelId: s.box.id });

    expect(series.address).toEqual({ id: s.ranch.id, title: "Rural ranch", archived: false });
    expect(series.parcel).toEqual({ id: s.box.id, title: "Medium box", archived: false });
    expect(series.runs.map((r) => r.runId)).toEqual([s.r1.id, s.r2.id, s.r3.id]);
    expect(series.runs[0]?.at).toEqual(new Date("2026-10-01T10:00:00Z"));
    const points = (name: string) =>
      series.lines
        .find((l) => l.serviceName === name)
        ?.points.map((p) => [p.runId, p.amountCents, p.deliveryDays]);
    expect(series.lines.map((l) => [l.carrierName, l.serviceName])).toEqual([
      ["UPS main", "UPS_GROUND"],
      ["USPS", "USPS_GA"],
      ["USPS", "USPS_PRIORITY"],
    ]);
    expect(points("UPS_GROUND")).toEqual([
      [s.r1.id, 1000, 4],
      [s.r2.id, 1200, 4],
      [s.r3.id, 990, 4],
    ]);
    expect(points("USPS_GA")).toEqual([
      [s.r2.id, 1100, 5],
      [s.r3.id, 900, 5],
    ]);
    expect(points("USPS_PRIORITY")).toHaveLength(3);
  });

  it("filters by carrier and range", async () => {
    const s = await seed();
    const actor = await createActor(db, ["ADMIN"]);
    const series = await labTrendSeries(db, actor, {
      addressId: s.ranch.id,
      parcelId: s.box.id,
      carrierIds: [s.ups.carrier.id],
      from: "2026-10-05",
    });
    expect(series.runs.map((r) => r.runId)).toEqual([s.r2.id, s.r3.id]);
    expect(series.lines.map((l) => l.serviceName)).toEqual(["UPS_GROUND"]);
  });

  it("keeps an archived combination's history", async () => {
    const s = await seed();
    const actor = await createActor(db, ["RATE_LAB"]);
    await db.rateLabAddress.update({ where: { id: s.ranch.id }, data: { archivedAt: new Date() } });
    const series = await labTrendSeries(db, actor, { addressId: s.ranch.id, parcelId: s.box.id });
    expect(series.address.archived).toBe(true);
    expect(series.runs).toHaveLength(3);
  });

  it("is not found for an unknown address and forbidden without the role", async () => {
    const s = await seed();
    const actor = await createActor(db, ["RATE_LAB"]);
    await expect(
      labTrendSeries(db, actor, { addressId: s.box.id, parcelId: s.box.id }),
    ).rejects.toThrowError("errors.notFound");
    await expect(
      labTrendSeries(db, await createActor(db, ["SHIPPER"]), {
        addressId: s.ranch.id,
        parcelId: s.box.id,
      }),
    ).rejects.toThrowError("errors.forbidden");
  });
});

describe("labRunTrends", () => {
  it("gives each saved combination its cheapest price per suite run up to the run", async () => {
    const s = await seed();
    const actor = await createActor(db, ["RATE_LAB"]);
    // A later run doesn't show in run 2's report.
    const later = await run("2026-10-22T10:00:00Z");
    await fetch(later.id, s.ranch.id, s.box.id, [{ service: s.ground, amountCents: 5000 }]);

    const trends = await labRunTrends(db, actor, { id: s.r2.id });
    const prices = (a: string, p: string) =>
      trends.find((t) => t.key === `${a}:${p}`)?.prices.map((x) => [x.runId, x.amountCents]);
    expect(trends.map((t) => t.key).sort()).toEqual(
      [`${s.ranch.id}:${s.box.id}`, `${s.ranch.id}:${s.tube.id}`].sort(),
    );
    expect(prices(s.ranch.id, s.box.id)).toEqual([
      [s.r1.id, 1000],
      [s.r2.id, 1100],
    ]);
    expect(prices(s.ranch.id, s.tube.id)).toEqual([[s.r2.id, 700]]);
  });

  it("stops at the last 10 suite runs", async () => {
    const s = await seed();
    const actor = await createActor(db, ["RATE_LAB"]);
    let last = s.r3;
    for (let day = 16; day < 28; day++) {
      last = await run(`2026-10-${day}T10:00:00Z`);
      await fetch(last.id, s.city.id, s.box.id, [{ service: s.ground, amountCents: 800 + day }]);
    }
    const trends = await labRunTrends(db, actor, { id: last.id });
    const prices = trends.find((t) => t.key === `${s.city.id}:${s.box.id}`)?.prices ?? [];
    expect(prices).toHaveLength(10);
    expect(prices.at(-1)).toMatchObject({ runId: last.id, amountCents: 827 });
    expect(prices[0]).toMatchObject({ amountCents: 818 });
  });

  it("is not found for an unknown run and forbidden without the role", async () => {
    const s = await seed();
    await expect(
      labRunTrends(db, await createActor(db, ["RATE_LAB"]), { id: s.box.id }),
    ).rejects.toThrowError("errors.notFound");
    await expect(
      labRunTrends(db, await createActor(db, ["SHIPPER"]), { id: s.r3.id }),
    ).rejects.toThrowError("errors.forbidden");
  });
});

describe("labTrendsReport", () => {
  it("gives the grid and a series per combination with data", async () => {
    const s = await seed();
    const actor = await createActor(db, ["RATE_LAB"]);
    const report = await labTrendsReport(db, actor, {});

    expect(report.grid.cells).toHaveLength(4);
    expect(report.omitted).toBe(0);
    // City × tube has no data, so three charts in grid order.
    expect(report.series.map((x) => [x.address.title, x.parcel.title])).toEqual([
      ["City flat", "Medium box"],
      ["Rural ranch", "Medium box"],
      ["Rural ranch", "Poster tube"],
    ]);
    const ranchBox = report.series[1];
    expect(ranchBox?.runs.map((r) => r.runId)).toEqual([s.r1.id, s.r2.id, s.r3.id]);
    expect(ranchBox).toEqual(
      await labTrendSeries(db, actor, { addressId: s.ranch.id, parcelId: s.box.id }),
    );

    const usps = await labTrendsReport(db, actor, { carrierIds: [s.usps.carrier.id] });
    expect(usps.series.map((x) => x.lines.map((l) => l.carrierName))).toEqual([
      ["USPS", "USPS"],
      ["USPS"],
    ]);
  });

  it("charts at most 60 combinations and counts the rest", async () => {
    const s = await seed();
    const actor = await createActor(db, ["RATE_LAB"]);
    for (let i = 0; i < 31; i++) {
      const p = await parcel(`Parcel ${String(i).padStart(2, "0")}`);
      for (const a of [s.ranch, s.city]) {
        await fetch(s.r3.id, a.id, p.id, [{ service: s.ground, amountCents: 500 + i }]);
      }
    }
    const report = await labTrendsReport(db, actor, {});
    // 62 new combinations plus the 3 seeded ones with data.
    expect(report.series).toHaveLength(60);
    expect(report.omitted).toBe(5);
  });

  it("is forbidden without the role", async () => {
    await expect(labTrendsReport(db, await createActor(db, ["QA"]), {})).rejects.toThrowError(
      "errors.forbidden",
    );
    await expect(
      labTrendsReport(db, await createActor(db, ["PACKER", "RATE_LAB"]), {}),
    ).resolves.toBeTruthy();
  });
});
