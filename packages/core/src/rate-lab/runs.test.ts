import type { LabRunSelection } from "@woolrus/contracts";
import type { Db, Prisma } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createFakeShippingProvider } from "../adapters/shipping/fake";
import type { ProviderId, RateRequest } from "../adapters/shipping/provider";
import { queues, RATE_LAB_RUN_EXPIRE_SECONDS } from "../jobs";
import { loadSettings } from "../settings/service";
import { createLabGroup } from "./catalog";
import {
  cancelLabRun,
  LAB_CONCURRENCY,
  LAB_QUEUED_STALL_MS,
  LAB_STALL_MS,
  listLabRuns,
  previewLabRun,
  runLabRun,
  runLabRunJob,
  startLabRun,
} from "./runs";

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(async () => {
  await resetDb(db);
  await db.$executeRaw`DELETE FROM pgboss.job WHERE name = ${queues.rateLabRun}`;
  await setShipFrom();
});

let key = 0;
const idempotencyKey = () => `key-${String(++key).padStart(8, "0")}`;
let wooId = 0;

const shipFrom = {
  name: "Warehouse",
  phone: "512-555-0000",
  address1: "100 Dock Rd",
  city: "Austin",
  state: "TX",
  postalCode: "78702",
  country: "US",
};

async function setShipFrom(address: unknown = shipFrom) {
  await loadSettings(db);
  await db.settings.updateMany({
    data: { shipFromAddress: address as Prisma.InputJsonValue },
  });
}

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

/** Both fakes with one domestic and one international service each on (saver/economy stay off). */
async function fakes(options: { latencyMs?: number } = {}) {
  await catalog("SHIPSTATION", ["demo_ground", "demo_express_intl"]);
  await catalog("BRIDGE_SOURCE", ["GND", "EXPINTL"]);
  const sent: RateRequest[] = [];
  const make = (id: ProviderId) => {
    const provider = createFakeShippingProvider(id, options);
    const getRates = provider.getRates.bind(provider);
    provider.getRates = (request: RateRequest) => {
      sent.push(request);
      return getRates(request);
    };
    provider.purchaseLabel = vi.fn(provider.purchaseLabel.bind(provider));
    return provider;
  };
  const shipStation = make("SHIPSTATION");
  const bridge = make("BRIDGE_SOURCE");
  return { shipStation, bridge, providers: [shipStation, bridge], sent };
}

function address(title: string, fields: { country?: string; archived?: boolean } = {}) {
  const value = {
    name: title,
    address1: "1 Main St",
    city: fields.country === "CA" ? "Toronto" : "Denver",
    state: fields.country === "CA" ? "ON" : "CO",
    postalCode: fields.country === "CA" ? "M5V 2T6" : "80202",
    country: fields.country ?? "US",
  };
  return db.rateLabAddress.create({
    data: {
      title,
      original: value,
      address: value,
      residential: true,
      checkStatus: "VERIFIED",
      archivedAt: fields.archived ? new Date() : null,
    },
  });
}

function parcel(
  title: string,
  fields: { archived?: boolean; items?: { productId: string; quantity: number }[] } = {},
) {
  return db.rateLabParcel.create({
    data: {
      title,
      lengthIn: 10,
      widthIn: 8,
      heightIn: 4,
      weightOz: 20,
      archivedAt: fields.archived ? new Date() : null,
      items: { create: fields.items ?? [] },
    },
  });
}

function product(name: string, customs: { hsCode?: string; countryOfOrigin?: string } = {}) {
  return db.product.create({
    data: {
      wooProductId: ++wooId,
      type: "simple",
      name,
      sku: name.toUpperCase(),
      physical: true,
      priceCents: 1500,
      hsCode: customs.hsCode ?? null,
      countryOfOrigin: customs.countryOfOrigin ?? null,
      rawPayload: {},
      syncedAt: new Date(),
    },
  });
}

const all = { addressGroupIds: [], addressIds: [], parcelGroupIds: [], parcelIds: [] };

async function people() {
  const admin = await createActor(db, ["ADMIN"]);
  const lab = await createActor(db, ["SHIPPER", "RATE_LAB"]);
  const shipper = await createActor(db, ["SHIPPER"]);
  return { admin, lab, shipper };
}

/** A queued run of `selection`, started by a Rate Lab user. */
async function started(
  providers: Awaited<ReturnType<typeof fakes>>["providers"],
  selection: LabRunSelection = all,
) {
  const { lab } = await people();
  const run = await startLabRun(
    db,
    lab,
    { idempotencyKey: idempotencyKey(), selection },
    { providers },
  );
  return { lab, run };
}

describe("previewLabRun", () => {
  it("counts addresses × parcels, each item once, never archived items or groups (SC 3, 4)", async () => {
    const { admin, lab } = await people();
    const west = await createLabGroup(db, admin, {
      idempotencyKey: idempotencyKey(),
      kind: "ADDRESS",
      name: "West",
    });
    const rural = await createLabGroup(db, admin, {
      idempotencyKey: idempotencyKey(),
      kind: "ADDRESS",
      name: "Rural",
    });
    const old = await createLabGroup(db, admin, {
      idempotencyKey: idempotencyKey(),
      kind: "ADDRESS",
      name: "Old",
    });
    const ranch = await address("Ranch");
    const denver = await address("Denver");
    const gone = await address("Gone", { archived: true });
    const lonely = await address("Lonely");
    for (const [a, g] of [
      [ranch, west],
      [ranch, rural],
      [denver, west],
      [gone, west],
      [lonely, old],
    ] as const) {
      await db.rateLabAddressGroup.create({ data: { addressId: a.id, groupId: g.id } });
    }
    await db.rateLabGroup.update({ where: { id: old.id }, data: { archivedAt: new Date() } });
    await parcel("Small");
    await parcel("Medium");
    await parcel("Retired", { archived: true });

    // All × all: active items only.
    expect(await previewLabRun(db, lab, { selection: all })).toEqual({
      addresses: 3,
      parcels: 2,
      combinations: 6,
      cap: 250,
      overCap: false,
    });
    // Ranch is in both groups and also picked by id: still one address.
    const picked = await previewLabRun(db, lab, {
      selection: { ...all, addressGroupIds: [west.id, rural.id, old.id], addressIds: [ranch.id] },
    });
    expect(picked).toMatchObject({ addresses: 2, parcels: 2, combinations: 4 });
    // Only an archived group, or an archived item by id: nothing.
    const archived = await previewLabRun(db, lab, {
      selection: { ...all, addressGroupIds: [old.id], addressIds: [gone.id] },
    });
    expect(archived).toMatchObject({ addresses: 0, combinations: 0 });
  });

  it("says when it's over the cap; forbidden without the Rate Lab role", async () => {
    const { lab, shipper } = await people();
    await db.settings.updateMany({ data: { rateLabMaxCombinations: 3 } });
    await address("A");
    await address("B");
    await parcel("P");
    await parcel("Q");
    expect(await previewLabRun(db, lab, { selection: all })).toMatchObject({
      combinations: 4,
      cap: 3,
      overCap: true,
    });
    await expect(previewLabRun(db, shipper, { selection: all })).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
  });
});

describe("startLabRun", () => {
  it("queues the run with a ship-from snapshot and its job, audited", async () => {
    const { providers } = await fakes();
    await address("A");
    await parcel("P");
    const { lab, run } = await started(providers);
    expect(run).toMatchObject({
      kind: "SUITE",
      status: "QUEUED",
      startedBy: { id: lab.userId },
      combinations: 1,
      completedCombinations: 0,
      addresses: { groups: [], items: 0 },
      parcels: { groups: [], items: 0 },
    });
    const stored = await db.rateLabRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(stored.shipFrom).toMatchObject({ postalCode: "78702" });
    const jobs = await db.$queryRaw<{ data: { runId: string }; expire_seconds: number }[]>`
      SELECT data, expire_seconds FROM pgboss.job WHERE name = ${queues.rateLabRun}`;
    expect(jobs.map((j) => j.data)).toEqual([{ runId: run.id }]);
    // A long run isn't failed by pg-boss's 15-minute default while it's still quoting.
    expect(jobs.map((j) => j.expire_seconds)).toEqual([RATE_LAB_RUN_EXPIRE_SECONDS]);
    const audit = await db.auditEvent.findMany({ where: { entityId: run.id } });
    expect(audit.map((e) => [e.entityType, e.action])).toEqual([["RateLabRun", "start"]]);
  });

  it("refuses an empty selection, over the cap (with both numbers), no provider, no ship-from; creating nothing (SC 4)", async () => {
    const { providers } = await fakes();
    const { lab } = await people();
    const start = (p = providers) =>
      startLabRun(db, lab, { idempotencyKey: idempotencyKey(), selection: all }, { providers: p });

    await expect(start()).rejects.toMatchObject({ messageKey: "errors.rateLab.emptySelection" });

    await address("A");
    await address("B");
    await parcel("P");
    await db.settings.updateMany({ data: { rateLabMaxCombinations: 1 } });
    await expect(start()).rejects.toMatchObject({
      messageKey: "errors.rateLab.overCap",
      params: { combinations: 2, cap: 1 },
    });

    await db.settings.updateMany({ data: { rateLabMaxCombinations: 250 } });
    await expect(start([])).rejects.toMatchObject({ messageKey: "errors.rateLab.noProviders" });

    await setShipFrom(null);
    await expect(start()).rejects.toMatchObject({ messageKey: "errors.carriers.noShipFrom" });

    expect(await db.rateLabRun.count()).toBe(0);
    expect(await db.auditEvent.count({ where: { entityType: "RateLabRun" } })).toBe(0);
  });

  it("is forbidden without the Rate Lab role", async () => {
    const { providers } = await fakes();
    const { shipper } = await people();
    await address("A");
    await parcel("P");
    await expect(
      startLabRun(db, shipper, { idempotencyKey: idempotencyKey(), selection: all }, { providers }),
    ).rejects.toMatchObject({ kind: "FORBIDDEN" });
  });

  it("refuses a second suite run while one is queued or running (SC 5)", async () => {
    const { providers } = await fakes();
    await address("A");
    await parcel("P");
    const { lab, run } = await started(providers);
    const again = () =>
      startLabRun(db, lab, { idempotencyKey: idempotencyKey(), selection: all }, { providers });
    await expect(again()).rejects.toMatchObject({
      kind: "CONFLICT",
      messageKey: "errors.rateLab.runActive",
    });
    await db.rateLabRun.update({ where: { id: run.id }, data: { status: "RUNNING" } });
    await expect(again()).rejects.toMatchObject({ messageKey: "errors.rateLab.runActive" });
    await db.rateLabRun.update({ where: { id: run.id }, data: { status: "SUCCEEDED" } });
    await expect(again()).resolves.toMatchObject({ status: "QUEUED" });
  });

  it("the one-active-run index itself refuses a second active suite run, not a one-off (SC 5)", async () => {
    const insert = (kind: "SUITE" | "ONE_OFF", status: "QUEUED" | "RUNNING") =>
      db.$executeRaw`
        INSERT INTO rate_lab_runs (id, kind, status, selection, ship_from, combinations,
          ad_hoc_address)
        VALUES (gen_random_uuid(), ${kind}::rate_lab_run_kind, ${status}::rate_lab_run_status,
          '{}', '{}', 1, ${kind === "ONE_OFF" ? "{}" : null}::jsonb)`;
    await insert("SUITE", "QUEUED");
    await expect(insert("SUITE", "RUNNING")).rejects.toThrow(/rate_lab_runs_one_active_suite/);
    await expect(insert("ONE_OFF", "RUNNING")).resolves.toBe(1);
  });

  it("replays the same key without a second run", async () => {
    const { providers } = await fakes();
    await address("A");
    await parcel("P");
    const { lab } = await people();
    const input = { idempotencyKey: idempotencyKey(), selection: all };
    const first = await startLabRun(db, lab, input, { providers });
    const second = await startLabRun(db, lab, input, { providers });
    expect(second.id).toBe(first.id);
    expect(await db.rateLabRun.count()).toBe(1);
  });

  it("replays a double submit: two starts at once with the same key get the same run", async () => {
    const { providers } = await fakes();
    await address("A");
    await parcel("P");
    const { lab } = await people();
    const input = { idempotencyKey: idempotencyKey(), selection: all };
    const [first, second] = await Promise.all([
      startLabRun(db, lab, input, { providers }),
      startLabRun(db, lab, input, { providers }),
    ]);
    expect(second.id).toBe(first.id);
    expect(await db.rateLabRun.count()).toBe(1);
  });
});

describe("the rateLab.run job", () => {
  it("logs a 3 × 2 run as 6 lab fetches with only enabled services, counts them and locks what it quoted (SC 6)", async () => {
    const { providers, sent } = await fakes();
    const addresses = [await address("A"), await address("B"), await address("C")];
    const parcels = [await parcel("P"), await parcel("Q")];
    const { run } = await started(providers);

    expect(await runLabRun(db, providers, { runId: run.id })).toEqual({ status: "SUCCEEDED" });

    const fetches = await db.rateFetch.findMany({ include: { quotes: true } });
    expect(fetches).toHaveLength(6);
    for (const fetch of fetches) {
      expect(fetch).toMatchObject({ source: "LAB", trigger: "LAB_RUN", labRunId: run.id });
      // One domestic service on per provider.
      expect(fetch.quotes.map((q) => q.serviceCode).sort()).toEqual(["GND", "demo_ground"]);
      expect(fetch.quotes.every((q) => q.fake)).toBe(true);
    }
    const pairs = fetches.map((f) => `${f.labAddressId}/${f.labParcelId}`).sort();
    expect(pairs).toEqual(addresses.flatMap((a) => parcels.map((p) => `${a.id}/${p.id}`)).sort());
    // Every request was a quick one, with the enabled domestic services only.
    expect(sent.every((r) => r.quick === true)).toBe(true);
    expect(new Set(sent.flatMap((r) => r.services.map((s) => s.code)))).toEqual(
      new Set(["demo_ground", "GND"]),
    );

    const done = await db.rateLabRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(done).toMatchObject({
      status: "SUCCEEDED",
      combinations: 6,
      completedCombinations: 6,
      quoteCount: 12,
      failureCount: 0,
      fake: true,
      error: null,
    });
    expect(done.startedAt).not.toBeNull();
    expect(done.finishedAt).not.toBeNull();
    expect(await db.rateLabAddress.count({ where: { lockedAt: null } })).toBe(0);
    expect(await db.rateLabParcel.count({ where: { lockedAt: null } })).toBe(0);
  });

  it("ends partial when one provider times out, with the failures counted (SC 7)", async () => {
    const { providers, shipStation } = await fakes();
    await address("A");
    await parcel("P");
    await parcel("Q");
    shipStation.failNext("timeout", 2);
    const { run } = await started(providers);
    expect(await runLabRun(db, providers, { runId: run.id })).toEqual({ status: "PARTIAL" });
    expect(await db.rateLabRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "PARTIAL",
      completedCombinations: 2,
      quoteCount: 2,
      failureCount: 2,
    });
    const errors = (await db.rateFetch.findMany()).map((f) => f.providerErrors);
    expect(errors).toEqual([
      [expect.objectContaining({ provider: "SHIPSTATION" })],
      [expect.objectContaining({ provider: "SHIPSTATION" })],
    ]);
  });

  it("ends failed when no provider quotes anything (SC 7)", async () => {
    const { providers, shipStation, bridge } = await fakes();
    await address("A");
    await parcel("P");
    shipStation.failNext(500);
    bridge.failNext(500);
    const { run } = await started(providers);
    expect(await runLabRun(db, providers, { runId: run.id })).toEqual({ status: "FAILED" });
    expect(await db.rateLabRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "FAILED",
      quoteCount: 0,
      failureCount: 2,
      error: "errors.rateLab.noQuotes",
    });
    expect(await db.rateFetch.count()).toBe(1);
  });

  it("logs an international parcel without contents as customs-incomplete and asks no provider (SC 8)", async () => {
    const { providers, shipStation, bridge } = await fakes();
    await address("Toronto", { country: "CA" });
    await parcel("Empty");
    const { run } = await started(providers);
    expect(await runLabRun(db, providers, { runId: run.id })).toEqual({ status: "FAILED" });
    expect(shipStation.requests).toEqual([]);
    expect(bridge.requests).toEqual([]);
    const fetch = await db.rateFetch.findFirstOrThrow();
    expect(fetch).toMatchObject({ international: true, labRunId: run.id });
    expect(fetch.providerErrors).toEqual([
      expect.objectContaining({ provider: null, messageKey: "errors.shipping.customsIncomplete" }),
    ]);
    expect(await db.rateLabRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      completedCombinations: 1,
      failureCount: 1,
    });
  });

  it("logs incomplete customs data the same way, naming the product (SC 8)", async () => {
    const { providers, shipStation } = await fakes();
    const soap = await product("Soap");
    await address("Toronto", { country: "CA" });
    await parcel("Soap box", { items: [{ productId: soap.id, quantity: 2 }] });
    const { run } = await started(providers);
    await runLabRun(db, providers, { runId: run.id });
    expect(shipStation.requests).toEqual([]);
    const fetch = await db.rateFetch.findFirstOrThrow();
    expect(fetch.providerErrors).toEqual([
      expect.objectContaining({
        messageKey: "errors.shipping.customsIncomplete",
        params: { products: "Soap" },
      }),
    ]);
  });

  it("declares an international parcel's contents with buildCustoms (SC 8)", async () => {
    const { providers, sent } = await fakes();
    const soap = await product("Soap", { hsCode: "340111", countryOfOrigin: "US" });
    await address("Toronto", { country: "CA" });
    await parcel("Soap box", { items: [{ productId: soap.id, quantity: 2 }] });
    const { run } = await started(providers);
    expect(await runLabRun(db, providers, { runId: run.id })).toEqual({ status: "SUCCEEDED" });
    expect(sent.length).toBeGreaterThan(0);
    for (const request of sent) {
      expect(request.customs?.items).toEqual([
        expect.objectContaining({
          sku: "SOAP",
          quantity: 2,
          valueCents: 3000,
          hsCode: "340111",
          countryOfOrigin: "US",
        }),
      ]);
      expect(request.items).toEqual([{ sku: "SOAP", name: "Soap", quantity: 2 }]);
      expect(request.services.map((s) => s.code)).toEqual(
        expect.arrayContaining([expect.stringMatching(/INTL|intl/)]),
      );
    }
    const quotes = await db.rateQuote.findMany();
    expect(quotes.map((q) => q.serviceCode).sort()).toEqual(["EXPINTL", "demo_express_intl"]);
  });

  it("never buys a label (SC 9)", async () => {
    const { providers, shipStation, bridge } = await fakes();
    await address("A");
    await address("Toronto", { country: "CA" });
    await parcel("P");
    const { run } = await started(providers);
    await runLabRun(db, providers, { runId: run.id });
    expect(shipStation.purchaseLabel).not.toHaveBeenCalled();
    expect(bridge.purchaseLabel).not.toHaveBeenCalled();
    expect(await db.shippingLabel.count()).toBe(0);
  });

  it("runs only items still active, and leaves a run that isn't queued alone", async () => {
    const { providers } = await fakes();
    await address("A");
    const retiring = await address("B");
    await parcel("P");
    const { run } = await started(providers);
    await db.rateLabAddress.update({
      where: { id: retiring.id },
      data: { archivedAt: new Date() },
    });
    await runLabRun(db, providers, { runId: run.id });
    expect(await db.rateLabRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      combinations: 1,
      completedCombinations: 1,
    });
    expect(await runLabRun(db, providers, { runId: run.id })).toEqual({ status: "skipped" });
    expect(await db.rateFetch.count()).toBe(1);
  });

  it("quotes what was selected at the start, not items added while it was queued", async () => {
    const { admin } = await people();
    const { providers } = await fakes();
    const west = await createLabGroup(db, admin, {
      idempotencyKey: idempotencyKey(),
      kind: "ADDRESS",
      name: "West",
    });
    const denver = await address("Denver");
    await db.rateLabAddressGroup.create({ data: { addressId: denver.id, groupId: west.id } });
    const small = await parcel("Small");
    // The West group × every parcel (the empty-lists default).
    const selection = { ...all, addressGroupIds: [west.id] };
    const { lab, run } = await started(providers, selection);

    const boulder = await address("Boulder");
    await db.rateLabAddressGroup.create({ data: { addressId: boulder.id, groupId: west.id } });
    await parcel("Large");

    await runLabRun(db, providers, { runId: run.id });
    const fetches = await db.rateFetch.findMany();
    expect(fetches.map((f) => [f.labAddressId, f.labParcelId])).toEqual([[denver.id, small.id]]);
    expect(await db.rateLabRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      combinations: 1,
      completedCombinations: 1,
    });
    // The list (and Run again) still read the selection as it was chosen.
    expect((await listLabRuns(db, lab, {})).rows[0]).toMatchObject({
      addresses: { groups: [{ id: west.id }], items: 0 },
      parcels: { groups: [], items: 0 },
    });
    const again = await startLabRun(
      db,
      lab,
      { idempotencyKey: idempotencyKey(), selection },
      { providers },
    );
    expect(again.combinations).toBe(4);
  });

  it("stops picking combinations once its signal is aborted, and ends failed at once", async () => {
    const { providers, shipStation } = await fakes();
    for (const title of ["A", "B", "C"]) await address(title);
    for (const title of ["P", "Q", "R"]) await parcel(title);
    const { lab, run } = await started(providers);
    const shutdown = new AbortController();
    const getRates = shipStation.getRates.bind(shipStation);
    shipStation.getRates = async (request) => {
      shutdown.abort();
      return getRates(request);
    };
    expect(await runLabRun(db, providers, { runId: run.id }, { signal: shutdown.signal })).toEqual({
      status: "FAILED",
    });
    const done = await db.rateLabRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(done).toMatchObject({
      status: "FAILED",
      error: "errors.rateLab.runFailed",
      finishedAt: expect.any(Date),
    });
    // The combinations already going were logged; no new one started.
    expect(done.completedCombinations).toBeGreaterThanOrEqual(1);
    expect(done.completedCombinations).toBeLessThanOrEqual(LAB_CONCURRENCY);
    expect(await db.rateFetch.count()).toBe(done.completedCombinations);
    // The one-active slot is free again.
    await expect(
      startLabRun(db, lab, { idempotencyKey: idempotencyKey(), selection: all }, { providers }),
    ).resolves.toMatchObject({ status: "QUEUED" });
  });

  it("ends failed on an unexpected error, and a new run can start after it", async () => {
    const { providers } = await fakes();
    await address("A");
    await parcel("P");
    const { lab, run } = await started(providers);
    // Logging a combination's quotes fails (the database went away mid-run, say).
    const transaction = vi
      .spyOn(db, "$transaction")
      .mockRejectedValue(new Error("connection lost"));
    try {
      await expect(runLabRun(db, providers, { runId: run.id })).rejects.toThrow("connection lost");
    } finally {
      transaction.mockRestore();
    }
    expect(await db.rateLabRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "FAILED",
      error: "errors.rateLab.runFailed",
      finishedAt: expect.any(Date),
    });
    await expect(
      startLabRun(db, lab, { idempotencyKey: idempotencyKey(), selection: all }, { providers }),
    ).resolves.toMatchObject({ status: "QUEUED" });
  });

  it("fails a queued run whose providers can't be built, rather than leave it queued", async () => {
    const { providers } = await fakes();
    await address("A");
    await parcel("P");
    const { run } = await started(providers);
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    try {
      // A saved credential that no longer decrypts.
      await db.shippingProviderAccount.create({
        data: { provider: "SHIPSTATION", enabled: true, credentialsEnc: "not-a-sealed-secret" },
      });
      await expect(runLabRunJob(db, { runId: run.id })).rejects.toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
    expect(await db.rateLabRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "FAILED",
      error: "errors.rateLab.runFailed",
      startedAt: null,
      finishedAt: expect.any(Date),
    });
    expect(await db.rateFetch.count()).toBe(0);
  });
});

describe("listLabRuns", () => {
  it("lists suite runs newest first with who started them and the groups picked, paged", async () => {
    const { providers } = await fakes();
    const { admin, lab, shipper } = await people();
    const west = await createLabGroup(db, admin, {
      idempotencyKey: idempotencyKey(),
      kind: "ADDRESS",
      name: "West",
    });
    const a = await address("A");
    await db.rateLabAddressGroup.create({ data: { addressId: a.id, groupId: west.id } });
    const p = await parcel("P");
    const first = await startLabRun(
      db,
      lab,
      { idempotencyKey: idempotencyKey(), selection: all },
      { providers },
    );
    await runLabRun(db, providers, { runId: first.id });
    const second = await startLabRun(
      db,
      lab,
      {
        idempotencyKey: idempotencyKey(),
        selection: { ...all, addressGroupIds: [west.id], parcelIds: [p.id] },
      },
      { providers },
    );

    const page = await listLabRuns(db, lab, { limit: 1 });
    expect(page.rows).toEqual([
      expect.objectContaining({
        id: second.id,
        status: "QUEUED",
        startedBy: { id: lab.userId, name: expect.any(String) },
        addresses: { groups: [{ id: west.id, name: "West", archived: false }], items: 0 },
        parcels: { groups: [], items: 1 },
      }),
    ]);
    const next = await listLabRuns(db, lab, { cursor: page.nextCursor ?? undefined });
    expect(next.rows.map((r) => [r.id, r.status, r.quoteCount])).toEqual([
      [first.id, "SUCCEEDED", 2],
    ]);
    expect(next.nextCursor).toBeNull();

    await expect(listLabRuns(db, shipper, {})).rejects.toMatchObject({ kind: "FORBIDDEN" });
  });
});

describe("cancelLabRun", () => {
  it("cancels a queued run at once, and its job then quotes nothing, audited", async () => {
    const { providers, sent } = await fakes();
    await address("A");
    await parcel("P");
    const { lab, run } = await started(providers);
    expect(await cancelLabRun(db, lab, { id: run.id })).toMatchObject({
      id: run.id,
      status: "CANCELLED",
      finishedAt: expect.any(Date),
    });
    expect(await runLabRun(db, providers, { runId: run.id })).toEqual({ status: "skipped" });
    expect(sent).toEqual([]);
    expect(await db.rateFetch.count()).toBe(0);
    const audit = await db.auditEvent.findMany({
      where: { entityId: run.id },
      orderBy: { at: "asc" },
    });
    expect(audit.map((e) => [e.action, e.actorId, e.before, e.after])).toEqual([
      ["start", lab.userId, null, expect.anything()],
      ["cancel", lab.userId, { status: "QUEUED" }, { status: "CANCELLED" }],
    ]);
  });

  it("stops a running run between combinations, keeping the ones it finished (SC 7)", async () => {
    const { providers, shipStation } = await fakes();
    for (const title of ["A", "B", "C"]) await address(title);
    for (const title of ["P", "Q", "R"]) await parcel(title);
    const { lab, run } = await started(providers);
    // The first quote asks to cancel, and every quote waits for that: the combinations already
    // going finish, and no new one starts.
    const getRates = shipStation.getRates.bind(shipStation);
    let cancelled: ReturnType<typeof cancelLabRun> | undefined;
    shipStation.getRates = async (request) => {
      cancelled ??= cancelLabRun(db, lab, { id: run.id });
      expect(await cancelled).toMatchObject({ status: "RUNNING", cancelRequested: true });
      return getRates(request);
    };
    expect(await runLabRun(db, providers, { runId: run.id })).toEqual({ status: "CANCELLED" });
    const done = await db.rateLabRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(done).toMatchObject({
      status: "CANCELLED",
      cancelRequestedAt: expect.any(Date),
      finishedAt: expect.any(Date),
    });
    expect(done.completedCombinations).toBeGreaterThanOrEqual(1);
    expect(done.completedCombinations).toBeLessThanOrEqual(LAB_CONCURRENCY);
    expect(await db.rateFetch.count({ where: { labRunId: run.id } })).toBe(
      done.completedCombinations,
    );
  });

  it("asks once: a second cancel of a running run changes nothing", async () => {
    const { providers } = await fakes();
    await address("A");
    await parcel("P");
    const { lab, run } = await started(providers);
    await db.rateLabRun.update({ where: { id: run.id }, data: { status: "RUNNING" } });
    await cancelLabRun(db, lab, { id: run.id });
    const first = await db.rateLabRun.findUniqueOrThrow({ where: { id: run.id } });
    await cancelLabRun(db, lab, { id: run.id });
    expect(await db.rateLabRun.findUniqueOrThrow({ where: { id: run.id } })).toEqual(first);
    expect(await db.auditEvent.count({ where: { entityId: run.id, action: "cancel" } })).toBe(1);
  });

  it("refuses a finished run or one that doesn't exist", async () => {
    const { providers } = await fakes();
    await address("A");
    await parcel("P");
    const { lab, run } = await started(providers);
    await runLabRun(db, providers, { runId: run.id });
    await expect(cancelLabRun(db, lab, { id: run.id })).rejects.toMatchObject({
      kind: "CONFLICT",
      messageKey: "errors.rateLab.runNotActive",
    });
    await expect(
      cancelLabRun(db, lab, { id: "00000000-0000-4000-8000-000000000000" }),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });
  });

  it("is forbidden without the Rate Lab role, and changes nothing", async () => {
    const { providers } = await fakes();
    await address("A");
    await parcel("P");
    const { run } = await started(providers);
    const { shipper } = await people();
    await expect(cancelLabRun(db, shipper, { id: run.id })).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
    expect(await db.rateLabRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "QUEUED",
      cancelRequestedAt: null,
    });
    expect(await db.auditEvent.count({ where: { action: "cancel" } })).toBe(0);
  });
});

describe("stuck runs", () => {
  const ago = (ms: number) => new Date(Date.now() - ms);

  it("a running run with an old heartbeat is failed as stalled and no longer blocks a new run (SC 5)", async () => {
    const { providers } = await fakes();
    await address("A");
    await parcel("P");
    const { lab, run } = await started(providers);
    await db.rateLabRun.update({
      where: { id: run.id },
      data: {
        status: "RUNNING",
        startedAt: ago(LAB_STALL_MS * 2),
        heartbeatAt: ago(LAB_STALL_MS + 1000),
      },
    });
    const next = await startLabRun(
      db,
      lab,
      { idempotencyKey: idempotencyKey(), selection: all },
      { providers },
    );
    expect(next.status).toBe("QUEUED");
    expect(await db.rateLabRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "FAILED",
      error: "errors.rateLab.stalled",
      finishedAt: expect.any(Date),
    });
  });

  it("uses the start time when there's no heartbeat, and leaves a fresh run alone", async () => {
    const { providers } = await fakes();
    await address("A");
    await parcel("P");
    const { lab, run } = await started(providers);
    await db.rateLabRun.update({
      where: { id: run.id },
      data: { status: "RUNNING", startedAt: ago(LAB_STALL_MS - 60_000), heartbeatAt: null },
    });
    await expect(
      startLabRun(db, lab, { idempotencyKey: idempotencyKey(), selection: all }, { providers }),
    ).rejects.toMatchObject({ messageKey: "errors.rateLab.runActive" });
    expect((await listLabRuns(db, lab, {})).rows[0]?.status).toBe("RUNNING");

    await db.rateLabRun.update({
      where: { id: run.id },
      data: { startedAt: ago(LAB_STALL_MS + 1000) },
    });
    expect((await listLabRuns(db, lab, {})).rows[0]).toMatchObject({
      id: run.id,
      status: "FAILED",
      error: "errors.rateLab.stalled",
    });
  });

  it("a run still queued past its job's expiry is failed as never started; a waiting one is left alone", async () => {
    const { providers } = await fakes();
    await address("A");
    await parcel("P");
    const { lab, run } = await started(providers);
    // Waiting a while (the worker is restarting, say) is fine.
    await db.rateLabRun.update({
      where: { id: run.id },
      data: { createdAt: ago(LAB_STALL_MS * 2) },
    });
    expect((await listLabRuns(db, lab, {})).rows[0]?.status).toBe("QUEUED");

    // Past the job's expiry, nothing will ever pick it up.
    expect(LAB_QUEUED_STALL_MS).toBeGreaterThan(RATE_LAB_RUN_EXPIRE_SECONDS * 1000);
    await db.rateLabRun.update({
      where: { id: run.id },
      data: { createdAt: ago(LAB_QUEUED_STALL_MS + 1000) },
    });
    const next = await startLabRun(
      db,
      lab,
      { idempotencyKey: idempotencyKey(), selection: all },
      { providers },
    );
    expect(next.status).toBe("QUEUED");
    expect(await db.rateLabRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "FAILED",
      error: "errors.rateLab.notStarted",
      finishedAt: expect.any(Date),
    });
    // Its job, if it ever runs, leaves the failed run alone.
    expect(await runLabRun(db, providers, { runId: run.id })).toEqual({ status: "skipped" });
  });

  it("a worker that wakes after its run was failed as stalled doesn't overwrite that", async () => {
    const { providers, shipStation } = await fakes();
    await address("A");
    await parcel("P");
    await parcel("Q");
    const { run } = await started(providers);
    const getRates = shipStation.getRates.bind(shipStation);
    shipStation.getRates = async (request) => {
      await db.rateLabRun.update({
        where: { id: run.id },
        data: { status: "FAILED", error: "errors.rateLab.stalled" },
      });
      return getRates(request);
    };
    expect(await runLabRun(db, providers, { runId: run.id })).toEqual({ status: "FAILED" });
    expect(await db.rateLabRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "FAILED",
      error: "errors.rateLab.stalled",
    });
  });
});
