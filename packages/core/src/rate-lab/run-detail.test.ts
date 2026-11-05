import type { Db, Prisma } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createFakeShippingProvider } from "../adapters/shipping/fake";
import type { ProviderId } from "../adapters/shipping/provider";
import { queues } from "../jobs";
import { loadSettings } from "../settings/service";
import { getLabRun } from "./run-detail";
import { runLabRun, startLabRun } from "./runs";

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(async () => {
  await resetDb(db);
  await db.$executeRaw`DELETE FROM pgboss.job WHERE name = ${queues.rateLabRun}`;
  await loadSettings(db);
  await db.settings.updateMany({ data: { shipFromAddress: shipFrom } });
});

let key = 0;
const idempotencyKey = () => `detail-${String(++key).padStart(8, "0")}`;

const shipFrom = {
  name: "Warehouse",
  phone: "512-555-0000",
  address1: "100 Dock Rd",
  city: "Austin",
  state: "TX",
  postalCode: "78702",
  country: "US",
};

/** Stores a fake's catalog as a sync would, with only `enabled` service codes on. */
async function catalog(provider: ProviderId, enabled: string[]) {
  for (const carrier of await createFakeShippingProvider(provider).listCarriers()) {
    await db.shippingCarrier.create({
      data: {
        provider,
        externalId: carrier.externalId,
        code: carrier.externalId,
        name: carrier.name,
        enabled: carrier.services.some((s) => enabled.includes(s.code)),
        services: {
          create: carrier.services.map((s) => ({
            code: s.code,
            name: s.name,
            domestic: s.domestic,
            international: s.international,
            enabled: enabled.includes(s.code),
            providerData: s.providerData as Prisma.InputJsonObject,
          })),
        },
      },
    });
  }
}

async function fakes() {
  await catalog("SHIPSTATION", ["demo_ground", "demo_express"]);
  await catalog("BRIDGE_SOURCE", ["GND"]);
  return [createFakeShippingProvider("SHIPSTATION"), createFakeShippingProvider("BRIDGE_SOURCE")];
}

function address(title: string) {
  const value = {
    name: title,
    address1: "1 Main St",
    city: "Denver",
    state: "CO",
    postalCode: "80202",
    country: "US",
  };
  return db.rateLabAddress.create({
    data: { title, original: value, address: value, residential: true, checkStatus: "VERIFIED" },
  });
}

function parcel(title: string) {
  return db.rateLabParcel.create({
    data: { title, lengthIn: 10, widthIn: 8, heightIn: 4, weightOz: 20 },
  });
}

const all = { addressGroupIds: [], addressIds: [], parcelGroupIds: [], parcelIds: [] };

describe("getLabRun", () => {
  it("loads a finished run: header, quotes cheapest first by combination, insights", async () => {
    const providers = await fakes();
    await address("Denver");
    await parcel("Small");
    await parcel("Large");
    const lab = await createActor(db, ["RATE_LAB"]);
    const started = await startLabRun(
      db,
      lab,
      { idempotencyKey: idempotencyKey(), selection: all },
      { providers },
    );
    await runLabRun(db, providers, { runId: started.id });

    const detail = await getLabRun(db, lab, { id: started.id });
    expect(detail.run).toMatchObject({
      id: started.id,
      status: "SUCCEEDED",
      startedBy: { id: lab.userId },
      combinations: 2,
      completedCombinations: 2,
    });
    expect(detail.run.finishedAt).toBeInstanceOf(Date);
    expect(detail.selection).toEqual(all);
    expect(detail.combinations.map((c) => [c.address?.title, c.parcel?.title])).toEqual([
      ["Denver", "Large"],
      ["Denver", "Small"],
    ]);
    for (const combination of detail.combinations) {
      expect(combination.quotes.length).toBe(3);
      const amounts = combination.quotes.map((q) => q.amountCents);
      expect(amounts).toEqual([...amounts].sort((a, b) => a - b));
      expect(combination.quotes.every((q) => q.carrierName !== "")).toBe(true);
      expect(combination.comparedWith).toBeNull();
    }
    expect(detail.insights.picks).toHaveLength(2);
    expect(detail.insights.picks[0]?.cheapestId).toBe(detail.combinations[0]?.quotes[0]?.id);
    expect(detail.insights.carrierWins.reduce((n, w) => n + w.wins, 0)).toBe(2);
    expect(detail.insights.moves).toEqual([]);
  });

  it("is forbidden without the Rate Lab role, and not found for an unknown run", async () => {
    const run = await db.rateLabRun.create({
      data: { kind: "SUITE", selection: all, shipFrom, combinations: 0 },
    });
    const shipper = await createActor(db, ["SHIPPER"]);
    await expect(getLabRun(db, shipper, { id: run.id })).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
    const admin = await createActor(db, ["ADMIN"]);
    await expect(getLabRun(db, admin, { id: run.id })).resolves.toMatchObject({
      run: { id: run.id },
    });
    await expect(
      getLabRun(db, admin, { id: "00000000-0000-7000-8000-000000000000" }),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });
    await expect(getLabRun(db, admin, { id: "nope" })).rejects.toMatchObject({
      kind: "NOT_FOUND",
    });
  });

  it("compares with the most recent earlier suite run of that combination, never a one-off", async () => {
    await catalog("SHIPSTATION", ["demo_ground"]);
    const service = await db.carrierService.findFirstOrThrow({ where: { code: "demo_ground" } });
    const home = await address("Home");
    const box = await parcel("Box");
    const other = await parcel("Other");
    const day = (n: number) => new Date(Date.UTC(2026, 9, n));

    const run = async (kind: "SUITE" | "ONE_OFF", createdAt: Date) =>
      db.rateLabRun.create({
        data: {
          kind,
          status: "SUCCEEDED",
          selection: all,
          shipFrom,
          combinations: 1,
          createdAt,
          ...(kind === "ONE_OFF" && { adHocAddress: {} }),
        },
      });
    const fetch = (runId: string, parcelId: string, cents: number | null) =>
      db.rateFetch.create({
        data: {
          source: "LAB",
          trigger: "LAB_RUN",
          labRunId: runId,
          labAddressId: home.id,
          labParcelId: parcelId,
          destCountry: "US",
          destState: "CO",
          residential: true,
          international: false,
          lengthIn: 10,
          widthIn: 8,
          heightIn: 4,
          weightOz: 20,
          fake: true,
          ...(cents === null
            ? {
                providerErrors: [
                  { provider: "SHIPSTATION", messageKey: "errors.carriers.timeout" },
                ],
              }
            : {
                quotes: {
                  create: {
                    provider: "SHIPSTATION",
                    carrierId: service.carrierId,
                    serviceId: service.id,
                    carrierCode: "demo",
                    serviceCode: service.code,
                    serviceName: service.name,
                    amountCents: cents,
                    currency: "USD",
                    guaranteed: false,
                    quoteOnly: false,
                    cheapest: true,
                    fake: true,
                  },
                },
              }),
        },
      });

    const oldest = await run("SUITE", day(1));
    await fetch(oldest.id, box.id, 900);
    const earlier = await run("SUITE", day(2));
    await fetch(earlier.id, box.id, 1000);
    const withoutBox = await run("SUITE", day(3));
    await fetch(withoutBox.id, other.id, 5000);
    const failedBox = await run("SUITE", day(4));
    await fetch(failedBox.id, box.id, null);
    const oneOff = await run("ONE_OFF", day(5));
    await fetch(oneOff.id, box.id, 3000);
    const current = await run("SUITE", day(6));
    await fetch(current.id, box.id, 1100);
    const later = await run("SUITE", day(7));
    await fetch(later.id, box.id, 9000);

    const lab = await createActor(db, ["RATE_LAB"]);
    const detail = await getLabRun(db, lab, { id: current.id });
    expect(detail.combinations[0]?.comparedWith).toEqual({ runId: earlier.id, createdAt: day(2) });
    expect(detail.insights.moves).toEqual([
      expect.objectContaining({
        combinationKey: `${home.id}:${box.id}`,
        kind: "CHANGED",
        previousCents: 1000,
        currentCents: 1100,
      }),
    ]);
  });

  it("compares each service with the latest earlier run that had it, fake with fake only", async () => {
    await catalog("SHIPSTATION", ["demo_ground", "demo_express"]);
    const ground = await db.carrierService.findFirstOrThrow({ where: { code: "demo_ground" } });
    const express = await db.carrierService.findFirstOrThrow({ where: { code: "demo_express" } });
    const home = await address("Home");
    const box = await parcel("Box");
    const day = (n: number) => new Date(Date.UTC(2026, 9, n));
    const quote = (service: typeof ground, amountCents: number, fake: boolean) => ({
      provider: "SHIPSTATION" as const,
      carrierId: service.carrierId,
      serviceId: service.id,
      carrierCode: "demo",
      serviceCode: service.code,
      serviceName: service.name,
      amountCents,
      currency: "USD",
      guaranteed: false,
      quoteOnly: false,
      cheapest: false,
      fake,
    });
    /** A suite run on `day(n)` with one fetch for Home × Box quoting `prices` per service. */
    const suite = async (n: number, fake: boolean, prices: [typeof ground, number][]) => {
      const run = await db.rateLabRun.create({
        data: {
          kind: "SUITE",
          status: "SUCCEEDED",
          selection: all,
          shipFrom,
          combinations: 1,
          createdAt: day(n),
          fake,
        },
      });
      await db.rateFetch.create({
        data: {
          source: "LAB",
          trigger: "LAB_RUN",
          labRunId: run.id,
          labAddressId: home.id,
          labParcelId: box.id,
          destCountry: "US",
          destState: "CO",
          residential: true,
          international: false,
          lengthIn: 10,
          widthIn: 8,
          heightIn: 4,
          weightOz: 20,
          fake,
          quotes: { create: prices.map(([service, cents]) => quote(service, cents, fake)) },
        },
      });
      return run;
    };

    await suite(1, true, [
      [ground, 1000],
      [express, 2000],
    ]);
    // A partial run: Express didn't answer.
    const partial = await suite(2, true, [[ground, 1000]]);
    const real = await suite(3, false, [
      [ground, 5000],
      [express, 9000],
    ]);
    const current = await suite(4, true, [
      [ground, 1000],
      [express, 2400],
    ]);
    const realCurrent = await suite(5, false, [[ground, 5500]]);

    const lab = await createActor(db, ["RATE_LAB"]);
    const key = `${home.id}:${box.id}`;
    const detail = await getLabRun(db, lab, { id: current.id });
    expect(detail.combinations[0]?.comparedWith).toEqual({ runId: partial.id, createdAt: day(2) });
    // Express against day 1 (not NEW); the real run on day 3 never counts.
    expect(detail.insights.moves).toEqual([
      expect.objectContaining({
        combinationKey: key,
        kind: "CHANGED",
        serviceId: express.id,
        previousCents: 2000,
        currentCents: 2400,
        changePct: 20,
      }),
    ]);

    const realDetail = await getLabRun(db, lab, { id: realCurrent.id });
    expect(realDetail.combinations[0]?.comparedWith).toEqual({ runId: real.id, createdAt: day(3) });
    expect(realDetail.insights.moves).toEqual([
      expect.objectContaining({ kind: "CHANGED", serviceId: ground.id, previousCents: 5000 }),
      expect.objectContaining({ kind: "MISSING", serviceId: express.id, previousCents: 9000 }),
    ]);
  });

  it("Run again starts a new run with the same selection", async () => {
    const providers = await fakes();
    const lab = await createActor(db, ["RATE_LAB"]);
    const denver = await address("Denver");
    await address("Boston");
    const small = await parcel("Small");
    await parcel("Large");
    const selection = { ...all, addressIds: [denver.id], parcelIds: [small.id] };
    const first = await startLabRun(
      db,
      lab,
      { idempotencyKey: idempotencyKey(), selection },
      { providers },
    );
    await db.rateLabRun.update({ where: { id: first.id }, data: { status: "SUCCEEDED" } });

    const { selection: again } = await getLabRun(db, lab, { id: first.id });
    const second = await startLabRun(
      db,
      lab,
      { idempotencyKey: idempotencyKey(), selection: again },
      { providers },
    );
    expect(second.id).not.toBe(first.id);
    expect(second.combinations).toBe(1);
    const stored = await db.rateLabRun.findUniqueOrThrow({ where: { id: second.id } });
    expect(stored.selection).toMatchObject(selection);
  });
});
