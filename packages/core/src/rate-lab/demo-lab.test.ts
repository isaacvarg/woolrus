import type { Db } from "@woolrus/db";
import { demoShipFrom } from "@woolrus/db/demo";
import { seedRateLab } from "@woolrus/db/demo-rate-lab";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createFakeShippingProvider } from "../adapters/shipping/fake";
import { checkAddress } from "../carriers/quote";
import { queues } from "../jobs";
import type { Actor } from "../permissions";
import { loadSettings } from "../settings/service";
import { getLabRun } from "./run-detail";
import { runLabRun, startLabRun } from "./runs";
import { labTrendGrid } from "./trends";

// SPEC-rate-lab "Dev data": the seed can't call core, so it writes what a run on the fakes would
// log; these tests hold it to the real fakes and to the screens it's meant to fill.

const db: Db = testDb();
afterAll(() => db.$disconnect());

let lab: Actor;
beforeEach(async () => {
  await resetDb(db);
  await db.$executeRaw`DELETE FROM pgboss.job WHERE name = ${queues.rateLabRun}`;
  lab = await createActor(db, ["RATE_LAB"]);
  // What seed.ts makes before the demo data.
  await loadSettings(db);
  await db.settings.updateMany({ data: { shipFromAddress: demoShipFrom } });
  await db.box.createMany({
    data: [
      {
        name: "Small mailer",
        lengthIn: 6,
        widthIn: 4,
        heightIn: 2,
        maxWeightOz: 64,
        tareWeightOz: 1.5,
      },
      {
        name: "Medium box",
        lengthIn: 10,
        widthIn: 8,
        heightIn: 4,
        maxWeightOz: 320,
        tareWeightOz: 5,
      },
    ],
  });
});

const now = new Date("2026-11-04T15:00:00Z");
const providers = () => [
  createFakeShippingProvider("SHIPSTATION"),
  createFakeShippingProvider("BRIDGE_SOURCE"),
];

/** A run's fetches by address × parcel, as the screens read them. */
async function logged(runId: string) {
  const fetches = await db.rateFetch.findMany({
    where: { labRunId: runId },
    include: { quotes: true },
  });
  return Object.fromEntries(
    fetches.map((f) => [
      `${f.labAddressId}:${f.labParcelId}`,
      {
        lane: [f.destCountry, f.destState, f.destZip3, f.residential, f.international, f.boxId],
        parcel: [f.lengthIn, f.widthIn, f.heightIn, f.weightOz].map(Number),
        errors: f.providerErrors,
        fake: f.fake,
        quotes: f.quotes
          .map((q) => [
            q.provider,
            q.serviceId,
            q.amountCents,
            q.deliveryDays,
            q.guaranteed,
            q.quoteOnly,
            q.cheapest,
            q.fake,
          ])
          .sort((a, b) => String(a).localeCompare(String(b))),
      },
    ]),
  );
}

describe("seedRateLab", () => {
  it("adds the addresses, parcels, groups and three runs, and re-running adds nothing", async () => {
    expect(await seedRateLab(db, { now, fakeShipping: true })).toBe(3);

    const addresses = await db.rateLabAddress.findMany({ include: { groups: true } });
    expect(addresses).toHaveLength(6);
    expect(addresses.filter((a) => a.checkStatus === "CORRECTED")).toHaveLength(2);
    expect(
      addresses.filter((a) => (a.original as { country: string }).country === "CA"),
    ).toHaveLength(1);
    expect(addresses.every((a) => a.groups.length > 0 && a.lockedAt)).toBe(true);

    const parcels = await db.rateLabParcel.findMany({ include: { items: true, groups: true } });
    expect(parcels).toHaveLength(4);
    expect(parcels.filter((p) => p.boxId)).toHaveLength(2);
    expect(parcels.filter((p) => p.items.length > 0)).toHaveLength(1);
    expect(parcels.every((p) => p.groups.length > 0 && p.lockedAt)).toBe(true);

    const runs = await db.rateLabRun.findMany({ orderBy: { startedAt: "asc" } });
    expect(
      runs.map((r) => [r.kind, r.status, r.fake, r.combinations, r.completedCombinations]),
    ).toEqual(Array(3).fill(["SUITE", "PARTIAL", true, 24, 24]));
    const [first, second, third] = runs.map((r) => r.startedAt?.getTime() ?? 0);
    expect([(second ?? 0) - (first ?? 0), (third ?? 0) - (second ?? 0)]).toEqual([
      7 * 86_400_000,
      7 * 86_400_000,
    ]);

    const counts = async () => ({
      groups: await db.rateLabGroup.count(),
      addresses: await db.rateLabAddress.count(),
      parcels: await db.rateLabParcel.count(),
      items: await db.rateLabParcelItem.count(),
      runs: await db.rateLabRun.count(),
      fetches: await db.rateFetch.count(),
      quotes: await db.rateQuote.count(),
    });
    const before = await counts();
    expect(before.groups).toBeGreaterThanOrEqual(4);
    expect(await seedRateLab(db, { now, fakeShipping: true })).toBe(0);
    expect(await counts()).toEqual(before);
  });

  it("checks addresses as the fake ShipStation does", async () => {
    await seedRateLab(db, { now, fakeShipping: true });
    const shipStation = [createFakeShippingProvider("SHIPSTATION")];
    for (const address of await db.rateLabAddress.findMany()) {
      const checked = await checkAddress(shipStation, address.original as never, { now });
      expect([address.address, address.checkStatus, address.residential], address.title).toEqual([
        checked.shipTo,
        checked.status,
        checked.residential,
      ]);
    }
  });

  it("leaves addresses unchecked and adds no runs without the fakes", async () => {
    expect(await seedRateLab(db, { now })).toBe(0);
    expect(await db.rateLabRun.count()).toBe(0);
    const addresses = await db.rateLabAddress.findMany();
    expect(addresses.map((a) => a.checkStatus)).toEqual(Array(6).fill("UNCHECKED"));
  });

  it("logs the latest run as a run on both fakes would", async () => {
    await seedRateLab(db, { now, fakeShipping: true });
    const seeded = await db.rateLabRun.findFirstOrThrow({ orderBy: { startedAt: "desc" } });
    const fakes = providers();
    const started = await startLabRun(
      db,
      lab,
      {
        idempotencyKey: "seed-check-0001",
        selection: { addressGroupIds: [], addressIds: [], parcelGroupIds: [], parcelIds: [] },
      },
      { providers: fakes },
    );
    expect(await runLabRun(db, fakes, { runId: started.id })).toEqual({ status: "PARTIAL" });

    const seededLog = await logged(seeded.id);
    expect(Object.keys(seededLog)).toHaveLength(24);
    expect(seededLog).toEqual(await logged(started.id));
    const real = await db.rateLabRun.findUniqueOrThrow({ where: { id: started.id } });
    expect([seeded.quoteCount, seeded.failureCount]).toEqual([real.quoteCount, real.failureCount]);
  });

  it("gives Trends a moving cell per domestic combination and the latest run a flagged move", async () => {
    await seedRateLab(db, { now, fakeShipping: true });
    const grid = await labTrendGrid(db, lab, { includeFake: true });
    expect(grid.cells).toHaveLength(24);
    const quoted = grid.cells.filter((c) => c.latest && c.previous);
    expect(quoted).toHaveLength(20);
    expect(quoted.every((c) => c.change !== 0)).toBe(true);
    // Fake data stays hidden unless asked.
    const hidden = await labTrendGrid(db, lab, {});
    expect(hidden.cells.every((c) => c.latest === null)).toBe(true);

    const latest = await db.rateLabRun.findFirstOrThrow({ orderBy: { startedAt: "desc" } });
    const detail = await getLabRun(db, lab, { id: latest.id });
    const moved = detail.insights.moves.filter((m) => m.kind === "CHANGED");
    expect(new Set(moved.map((m) => m.serviceName))).toEqual(new Set(["Demo Ground Saver"]));
  });
});
