import type { LabShipAddress } from "@woolrus/contracts";
import type { Db, Prisma } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createFakeShippingProvider } from "../adapters/shipping/fake";
import type { ProviderId, RateRequest } from "../adapters/shipping/provider";
import { queues } from "../jobs";
import { purgePii } from "../operations/anonymize";
import { loadSettings } from "../settings/service";
import { createLabGroup } from "./catalog";
import { quoteOneOff, saveOneOffAddress, saveOneOffParcel } from "./one-off";
import { listLabRuns, startLabRun } from "./runs";

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(async () => {
  await resetDb(db);
  await db.$executeRaw`DELETE FROM pgboss.job WHERE name = ${queues.rateLabRun}`;
  await loadSettings(db);
  await db.settings.updateMany({ data: { shipFromAddress: shipFrom } });
});

let key = 0;
const idempotencyKey = () => `key-${String(++key).padStart(8, "0")}`;

const shipFrom = {
  name: "Warehouse",
  phone: "512-555-0000",
  address1: "100 Dock Rd",
  city: "Austin",
  state: "TX",
  postalCode: "78702",
  country: "US",
};

/** Typed the way a person would; the ShipStation fake abbreviates "Street". */
const typed: LabShipAddress = {
  name: "Pat Buyer",
  address1: "12 Prairie Street",
  city: "Jordan",
  state: "MT",
  postalCode: "59337",
  country: "US",
};

const canadian: LabShipAddress = {
  name: "Sam",
  address1: "1 King St W",
  city: "Toronto",
  state: "ON",
  postalCode: "M5V 2T6",
  country: "CA",
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

/** Both fakes, one domestic and one international service each, with spies on what they're sent. */
async function fakes() {
  await catalog("SHIPSTATION", ["demo_ground", "demo_express_intl"]);
  await catalog("BRIDGE_SOURCE", ["GND", "EXPINTL"]);
  const sent: RateRequest[] = [];
  const make = (id: ProviderId) => {
    const provider = createFakeShippingProvider(id);
    const getRates = provider.getRates.bind(provider);
    provider.getRates = (request: RateRequest) => {
      sent.push(request);
      return getRates(request);
    };
    provider.purchaseLabel = vi.fn(provider.purchaseLabel.bind(provider));
    return provider;
  };
  const providers = [make("SHIPSTATION"), make("BRIDGE_SOURCE")];
  return { providers, sent };
}

function parcel(title: string, fields: { archived?: boolean } = {}) {
  return db.rateLabParcel.create({
    data: {
      title,
      lengthIn: 10,
      widthIn: 8,
      heightIn: 4,
      weightOz: 20,
      archivedAt: fields.archived ? new Date() : null,
    },
  });
}

const box = () =>
  db.box.create({ data: { name: "Medium", lengthIn: 12, widthIn: 10, heightIn: 6 } });

async function people() {
  const admin = await createActor(db, ["ADMIN"]);
  const lab = await createActor(db, ["SHIPPER", "RATE_LAB"]);
  const shipper = await createActor(db, ["SHIPPER"]);
  return { admin, lab, shipper };
}

const typedParcel = { size: { lengthIn: 9, widthIn: 6, heightIn: 3 }, weightOz: 12 };

describe("quoteOneOff", () => {
  it("returns quotes for each parcel in the same request: saved by id or group, typed, from a box (SC 10)", async () => {
    const { providers } = await fakes();
    const { admin, lab } = await people();
    const small = await parcel("Small");
    const grouped = await parcel("Grouped");
    const group = await createLabGroup(db, admin, {
      idempotencyKey: idempotencyKey(),
      kind: "PARCEL",
      name: "Fragile",
    });
    await db.rateLabParcelGroup.create({ data: { parcelId: grouped.id, groupId: group.id } });
    const medium = await box();

    const result = await quoteOneOff(
      db,
      lab,
      {
        address: typed,
        parcelIds: [small.id],
        parcelGroupIds: [group.id],
        adHocParcels: [typedParcel, { size: { boxId: medium.id }, weightOz: 30 }],
      },
      { providers },
    );

    expect(result).toMatchObject({
      status: "SUCCEEDED",
      fake: true,
      check: {
        status: "CORRECTED",
        original: typed,
        address: { address1: "12 Prairie St" },
        residential: true,
      },
    });
    expect(
      result.parcels.map((p) => [p.parcel?.title ?? null, p.adHocIndex, p.lengthIn, p.weightOz]),
    ).toEqual([
      ["Grouped", null, 10, 20],
      ["Small", null, 10, 20],
      [null, 0, 9, 12],
      [null, 1, 12, 30],
    ]);
    expect(result.parcels[3]?.boxId).toBe(medium.id);
    for (const answer of result.parcels) {
      // One domestic service per fake, cheapest first, one of them marked cheapest.
      expect(answer.quotes).toHaveLength(2);
      expect(answer.errors).toEqual([]);
      const amounts = answer.quotes.map((q) => q.amountCents);
      expect(amounts).toEqual([...amounts].sort((a, b) => a - b));
      expect(answer.quotes.filter((q) => q.cheapest)).toHaveLength(1);
    }

    // Kept as a one-off run with what was typed; the address isn't a test address.
    const run = await db.rateLabRun.findUniqueOrThrow({ where: { id: result.runId } });
    expect(run).toMatchObject({
      kind: "ONE_OFF",
      status: "SUCCEEDED",
      startedById: lab.userId,
      adHocAddress: typed,
      adHocParcels: [
        { boxId: null, lengthIn: 9, widthIn: 6, heightIn: 3, weightOz: 12 },
        { boxId: medium.id, lengthIn: 12, widthIn: 10, heightIn: 6, weightOz: 30 },
      ],
      combinations: 4,
      completedCombinations: 4,
      quoteCount: 8,
      failureCount: 0,
    });
    expect(run.finishedAt).toBeInstanceOf(Date);
    expect(await db.rateLabAddress.count()).toBe(0);

    // One LAB fetch per parcel, tied to saved parcels only, never to an address.
    const fetches = await db.rateFetch.findMany({ where: { labRunId: run.id } });
    expect(fetches).toHaveLength(4);
    expect(fetches.every((f) => f.source === "LAB" && f.labAddressId === null)).toBe(true);
    expect(fetches.map((f) => f.labParcelId).sort()).toEqual(
      [grouped.id, small.id, null, null].sort(),
    );
    // The saved parcels it quoted are locked, like a suite run's.
    expect((await db.rateLabParcel.findMany()).every((p) => p.lockedAt !== null)).toBe(true);
    // Not a suite run: the runs list (and Trends) leave it out.
    expect((await listLabRuns(db, lab, {})).rows).toEqual([]);
    const audit = await db.auditEvent.findMany({ where: { entityId: run.id } });
    expect(audit.map((e) => [e.entityType, e.action])).toEqual([["RateLabRun", "quoteOneOff"]]);
    expect(JSON.stringify(audit[0]?.after)).not.toContain("Prairie");
  });

  it("takes 1 to 20 parcels, only active saved ones, and needs a provider; refusals create nothing (SC 10)", async () => {
    const { providers } = await fakes();
    const { lab } = await people();
    const quote = (input: Partial<Parameters<typeof quoteOneOff>[2]>, p = providers) =>
      quoteOneOff(db, lab, { address: typed, ...input }, { providers: p });

    await expect(quote({})).rejects.toMatchObject({
      messageKey: "errors.rateLab.oneOffNoParcels",
    });
    const small = await parcel("Small");
    await expect(
      quote({ parcelIds: [small.id], adHocParcels: Array(20).fill(typedParcel) }),
    ).rejects.toMatchObject({
      messageKey: "errors.rateLab.oneOffTooMany",
      params: { parcels: 21, max: 20 },
    });
    await expect(quote({ adHocParcels: Array(21).fill(typedParcel) })).rejects.toThrow(/too_big/);
    const retired = await parcel("Retired", { archived: true });
    await expect(quote({ parcelIds: [retired.id] })).rejects.toMatchObject({
      messageKey: "errors.rateLab.parcelInvalid",
    });
    await expect(quote({ adHocParcels: [typedParcel] }, [])).rejects.toMatchObject({
      messageKey: "errors.rateLab.noProviders",
    });
    expect(await db.rateLabRun.count()).toBe(0);

    await expect(quote({ adHocParcels: Array(20).fill(typedParcel) })).resolves.toMatchObject({
      status: "SUCCEEDED",
    });
  });

  it("works while a suite run is queued or running (SC 5)", async () => {
    const { providers } = await fakes();
    const { lab } = await people();
    await db.rateLabAddress.create({
      data: {
        title: "A",
        original: typed,
        address: typed,
        residential: true,
        checkStatus: "VERIFIED",
      },
    });
    await parcel("P");
    const suite = await startLabRun(
      db,
      lab,
      { idempotencyKey: idempotencyKey(), selection: {} },
      { providers },
    );
    const quote = () =>
      quoteOneOff(db, lab, { address: typed, adHocParcels: [typedParcel] }, { providers });

    await expect(quote()).resolves.toMatchObject({ status: "SUCCEEDED" });
    await db.rateLabRun.update({ where: { id: suite.id }, data: { status: "RUNNING" } });
    await expect(quote()).resolves.toMatchObject({ status: "SUCCEEDED" });
  });

  it("asks for quick quotes and never buys a label (SC 9)", async () => {
    const { providers, sent } = await fakes();
    const { lab } = await people();
    await quoteOneOff(db, lab, { address: typed, adHocParcels: [typedParcel] }, { providers });
    expect(sent).toHaveLength(2);
    expect(sent.every((request) => request.quick === true)).toBe(true);
    for (const provider of providers) expect(provider.purchaseLabel).not.toHaveBeenCalled();
  });

  it("stops quoting once a combination throws, and fails the run with nothing left running", async () => {
    const { providers, sent } = await fakes();
    const { lab } = await people();
    // A provider answer the quote code can't read makes the first parcel throw; the others are
    // slow enough that, without a stop, the other workers would go on to the rest.
    const [shipStation] = providers;
    if (!shipStation) throw new Error("missing provider");
    const getRates = shipStation.getRates;
    shipStation.getRates = async (request: RateRequest) => {
      if (request.package.lengthIn === 1) {
        sent.push(request);
        return null as unknown as Awaited<ReturnType<typeof getRates>>;
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
      return getRates(request);
    };
    const broken = { size: { lengthIn: 1, widthIn: 1, heightIn: 1 }, weightOz: 1 };

    await expect(
      quoteOneOff(
        db,
        lab,
        { address: typed, adHocParcels: [broken, ...Array(9).fill(typedParcel)] },
        { providers },
      ),
    ).rejects.toThrow(TypeError);

    // The broken parcel, and the two in flight beside it (LAB_CONCURRENCY), each to both fakes.
    expect(sent).toHaveLength(6);
    const run = await db.rateLabRun.findFirstOrThrow({ where: { kind: "ONE_OFF" } });
    expect(run).toMatchObject({ status: "FAILED", error: "errors.rateLab.runFailed" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sent).toHaveLength(6);
    expect(await db.rateLabRun.findUniqueOrThrow({ where: { id: run.id } })).toEqual(run);
  });

  it("logs an international typed parcel as customs-incomplete without asking anyone", async () => {
    const { providers, sent } = await fakes();
    const { lab } = await people();
    const result = await quoteOneOff(
      db,
      lab,
      { address: canadian, adHocParcels: [typedParcel, typedParcel] },
      { providers },
    );
    expect(sent).toEqual([]);
    // Named by number, as the Quote tab numbers typed parcels: no English inside the message.
    const incomplete = (products: string) => ({
      quotes: [],
      errors: [
        { provider: null, messageKey: "errors.shipping.customsIncomplete", params: { products } },
      ],
    });
    expect(result).toMatchObject({
      status: "FAILED",
      parcels: [incomplete("#1"), incomplete("#2")],
    });
  });

  it("is allowed to the Rate Lab role and forbidden without it", async () => {
    const { providers } = await fakes();
    const { admin, shipper } = await people();
    await expect(
      quoteOneOff(db, shipper, { address: typed, adHocParcels: [typedParcel] }, { providers }),
    ).rejects.toMatchObject({ kind: "FORBIDDEN" });
    await expect(
      quoteOneOff(db, admin, { address: typed, adHocParcels: [typedParcel] }, { providers }),
    ).resolves.toMatchObject({ status: "SUCCEEDED" });
  });
});

/** A finished one-off of `typed` with one typed parcel and one from a box. */
async function oneOff() {
  const { providers } = await fakes();
  const users = await people();
  const medium = await box();
  const quote = async () =>
    (
      await quoteOneOff(
        db,
        users.lab,
        {
          address: typed,
          adHocParcels: [typedParcel, { size: { boxId: medium.id }, weightOz: 30 }],
        },
        { providers },
      )
    ).runId;
  return { ...users, providers, medium, quote, runId: await quote() };
}

describe("saveOneOffAddress", () => {
  it("creates an unlocked test address with the typed original, checked again; a replay doesn't add one (SC 10)", async () => {
    const { admin, lab, providers, runId } = await oneOff();
    const west = await createLabGroup(db, admin, {
      idempotencyKey: idempotencyKey(),
      kind: "ADDRESS",
      name: "West",
    });
    const input = { idempotencyKey: idempotencyKey(), runId, title: "Ranch", groupIds: [west.id] };
    const saved = await saveOneOffAddress(db, lab, input, { providers });
    expect(saved).toMatchObject({
      title: "Ranch",
      original: typed,
      address: { address1: "12 Prairie St" },
      checkStatus: "CORRECTED",
      locked: false,
      groups: [{ name: "West" }],
    });
    expect(await saveOneOffAddress(db, lab, input, { providers })).toMatchObject({ id: saved.id });
    expect(await db.rateLabAddress.count()).toBe(1);
  });

  it("refuses a suite run and a one-off the purge cleared", async () => {
    const { lab, providers, runId } = await oneOff();
    const save = (id: string) =>
      saveOneOffAddress(
        db,
        lab,
        { idempotencyKey: idempotencyKey(), runId: id, title: "Ranch" },
        { providers },
      );
    await parcel("P");
    await db.rateLabAddress.create({
      data: {
        title: "A",
        original: typed,
        address: typed,
        residential: true,
        checkStatus: "VERIFIED",
      },
    });
    const suite = await startLabRun(
      db,
      lab,
      { idempotencyKey: idempotencyKey(), selection: {} },
      { providers },
    );
    await expect(save(suite.id)).rejects.toMatchObject({ kind: "NOT_FOUND" });
    await db.$executeRaw`UPDATE rate_lab_runs SET ad_hoc_address = NULL WHERE id = ${runId}::uuid`;
    await expect(save(runId)).rejects.toMatchObject({ messageKey: "errors.rateLab.oneOffPurged" });
  });

  it("is allowed to the Rate Lab role and forbidden without it", async () => {
    const { shipper, providers, runId } = await oneOff();
    await expect(
      saveOneOffAddress(
        db,
        shipper,
        { idempotencyKey: idempotencyKey(), runId, title: "Ranch" },
        { providers },
      ),
    ).rejects.toMatchObject({ kind: "FORBIDDEN" });
  });
});

describe("saveOneOffParcel", () => {
  it("creates an unlocked test parcel of the typed size, keeping its box (SC 10)", async () => {
    const { lab, medium, runId } = await oneOff();
    const typedOne = await saveOneOffParcel(db, lab, {
      idempotencyKey: idempotencyKey(),
      runId,
      index: 0,
      title: "Small mailer",
    });
    expect(typedOne).toMatchObject({
      title: "Small mailer",
      box: null,
      lengthIn: 9,
      widthIn: 6,
      heightIn: 3,
      weightOz: 12,
      items: [],
      locked: false,
    });
    const boxed = await saveOneOffParcel(db, lab, {
      idempotencyKey: idempotencyKey(),
      runId,
      index: 1,
      title: "Medium, 30 oz",
    });
    expect(boxed).toMatchObject({ box: { id: medium.id }, lengthIn: 12, weightOz: 30 });
  });

  it("keeps the quoted size, without the box, when the box changed since", async () => {
    const { lab, medium, runId } = await oneOff();
    await db.box.update({ where: { id: medium.id }, data: { lengthIn: 14 } });
    const saved = await saveOneOffParcel(db, lab, {
      idempotencyKey: idempotencyKey(),
      runId,
      index: 1,
      title: "Medium, 30 oz",
    });
    expect(saved).toMatchObject({ box: null, lengthIn: 12 });
  });

  it("refuses an index the one-off doesn't have", async () => {
    const { lab, runId } = await oneOff();
    await expect(
      saveOneOffParcel(db, lab, { idempotencyKey: idempotencyKey(), runId, index: 2, title: "X" }),
    ).rejects.toMatchObject({ messageKey: "errors.rateLab.oneOffParcelInvalid" });
  });

  it("is forbidden without the Rate Lab role", async () => {
    const { shipper, runId } = await oneOff();
    await expect(
      saveOneOffParcel(db, shipper, {
        idempotencyKey: idempotencyKey(),
        runId,
        index: 0,
        title: "X",
      }),
    ).rejects.toMatchObject({ kind: "FORBIDDEN" });
  });
});

describe("the PII purge and one-off quotes", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("clears the typed address of one-offs past the period and keeps their fetches (SC 10)", async () => {
    const { runId, quote } = await oneOff();
    const recent = { runId: await quote() };
    await db.settings.updateMany({ data: { piiRetentionDays: 30 } });
    const now = new Date(Date.now() + 31 * DAY);
    await db.rateLabRun.update({
      where: { id: recent.runId },
      data: { createdAt: new Date(now.getTime() - 29 * DAY) },
    });

    expect(await purgePii(db, { now, dryRun: true })).toMatchObject({ labRuns: 1 });
    expect(await purgePii(db, { now })).toMatchObject({ labRuns: 1 });
    const run = await db.rateLabRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.adHocAddress).toBeNull();
    // The typed parcels and the fetches, which only ever held the lane, stay.
    expect(run.adHocParcels).toHaveLength(2);
    const fetches = await db.rateFetch.findMany({ where: { labRunId: runId } });
    expect(fetches).toHaveLength(2);
    expect(fetches[0]).toMatchObject({ destCountry: "US", destState: "MT", destZip3: "593" });
    expect(
      (await db.rateLabRun.findUniqueOrThrow({ where: { id: recent.runId } })).adHocAddress,
    ).toEqual(typed);
    expect(await purgePii(db, { now })).toMatchObject({ labRuns: 0 });
  });

  it("clears nothing without a retention period", async () => {
    const { runId } = await oneOff();
    const now = new Date(Date.now() + 3650 * DAY);
    expect(await purgePii(db, { now })).toMatchObject({ labRuns: 0 });
    expect((await db.rateLabRun.findUniqueOrThrow({ where: { id: runId } })).adHocAddress).toEqual(
      typed,
    );
  });
});
