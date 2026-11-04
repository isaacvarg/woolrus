import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import { csvStream } from "../csv";
import { type CsvExport, labRunCsv, realOrdersCsv } from "./exports";

// SPEC-rate-lab "Exports" (criteria 14, 15): the column set and quoting of both CSVs, CSV
// injection, the dashboard's filters, and the permission each one needs.

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const now = new Date("2026-11-03T12:00:00Z");
const shipFrom = { name: "Warehouse", address1: "1 Dock", city: "Austin", state: "TX" };
let key = 0;

async function text({ header, rows }: CsvExport) {
  const bytes = new Uint8Array(await new Response(csvStream(header, rows)).arrayBuffer());
  expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  return new TextDecoder().decode(bytes.slice(3));
}

async function services() {
  const carrier = await db.shippingCarrier.create({
    data: {
      provider: "SHIPSTATION",
      externalId: "se-ups",
      code: "ups",
      name: "UPS",
      label: "UPS, main",
      enabled: true,
    },
  });
  const make = (code: string, name: string) =>
    db.carrierService.create({
      data: {
        carrierId: carrier.id,
        code,
        name,
        domestic: true,
        international: false,
        enabled: true,
      },
    });
  return { ground: await make("ground", "Ground"), air: await make("air", 'Next "Day" Air') };
}

type Service = Awaited<ReturnType<typeof services>>["ground"];

const quote = (service: Service, amountCents: number, deliveryDays: number | null) => ({
  provider: "SHIPSTATION" as const,
  carrierId: service.carrierId,
  serviceId: service.id,
  carrierCode: "ups",
  serviceCode: service.code,
  serviceName: service.name,
  amountCents,
  currency: "USD",
  deliveryDays,
  guaranteed: false,
  quoteOnly: false,
  cheapest: false,
  fake: false,
});

const dims = { lengthIn: 10, widthIn: 8, heightIn: 4, weightOz: 20 };
const fetchDims = { ...dims, fake: false };

describe("labRunCsv", () => {
  it("writes one row per quote with the run's columns, escaping a title that starts with =", async () => {
    const { ground, air } = await services();
    const value = { name: "x", address1: "1 Main", city: "Denver", state: "CO", country: "US" };
    const address = await db.rateLabAddress.create({
      data: {
        title: "=HYPERLINK(1)",
        original: value,
        address: value,
        residential: true,
        checkStatus: "VERIFIED",
      },
    });
    const parcel = await db.rateLabParcel.create({ data: { title: "Small, flat", ...dims } });
    const run = await db.rateLabRun.create({
      data: {
        kind: "SUITE",
        status: "SUCCEEDED",
        selection: {},
        shipFrom,
        combinations: 2,
        createdAt: now,
      },
    });
    const fetch = (data: object) =>
      db.rateFetch.create({
        data: {
          source: "LAB",
          trigger: "LAB_RUN",
          labRunId: run.id,
          destCountry: "US",
          destState: "CO",
          residential: true,
          international: false,
          ...fetchDims,
          ...data,
        },
      });
    await fetch({
      labAddressId: address.id,
      labParcelId: parcel.id,
      quotes: { create: [quote(air, 2550, 1), quote(ground, 899, null)] },
    });
    // A typed-in combination (a one-off's) has no titles: the lane stands in for the address.
    await fetch({ destState: "NY", quotes: { create: [quote(ground, 1000, 4)] } });

    const lab = await createActor(db, ["RATE_LAB"]);
    const csv = await labRunCsv(db, lab, { id: run.id });
    expect(csv.filename).toBe(`rate-lab-run-2026-11-03-${run.id.slice(0, 8)}.csv`);
    expect((await text(csv)).split("\r\n")).toEqual([
      "Run,Address,Parcel,Provider,Carrier,Service,Amount,Currency,Delivery days,Cheapest,Bought,Reason",
      `${run.id},US-NY,,SHIPSTATION,"UPS, main",Ground,10,USD,4,yes,,`,
      `${run.id},'=HYPERLINK(1),"Small, flat",SHIPSTATION,"UPS, main",Ground,8.99,USD,,yes,,`,
      `${run.id},'=HYPERLINK(1),"Small, flat",SHIPSTATION,"UPS, main","Next ""Day"" Air",25.5,USD,1,no,,`,
      "",
    ]);
  });

  it("needs ratelab.use", async () => {
    const run = await db.rateLabRun.create({
      data: { kind: "SUITE", selection: {}, shipFrom, combinations: 0 },
    });
    const shipper = await createActor(db, ["SHIPPER"]);
    await expect(labRunCsv(db, shipper, { id: run.id })).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
    const picker = await createActor(db, ["PICKER", "RATE_LAB"]);
    await expect(labRunCsv(db, picker, { id: run.id })).resolves.toMatchObject({
      header: expect.arrayContaining(["Run"]),
    });
  });
});

describe("realOrdersCsv", () => {
  /** An order with one package bought on `buy` of its fetch's quotes (cheapest first). */
  async function bought(
    number: string,
    state: string,
    quotes: ReturnType<typeof quote>[],
    buy: number,
    reason: "FASTER_DELIVERY" | null,
    purchasedAt: string,
  ) {
    const built = await createOrder(db, { number, packages: [{}] });
    const pkg = built.packages[0];
    if (!pkg?.boxId) throw new Error("missing package");
    await db.box.update({ where: { id: pkg.boxId }, data: { name: `Box ${number}` } });
    const fetch = await db.rateFetch.create({
      data: {
        source: "ORDER",
        trigger: "PACKING_COMPLETE",
        orderId: built.order.id,
        packageId: pkg.id,
        destCountry: "US",
        destState: state,
        residential: true,
        international: false,
        boxId: pkg.boxId,
        ...fetchDims,
        fetchedAt: new Date(purchasedAt),
      },
    });
    const rows = [];
    for (const [i, q] of quotes.entries()) {
      rows.push(
        await db.rateQuote.create({ data: { ...q, fetchId: fetch.id, cheapest: i === 0 } }),
      );
    }
    const pick = rows[buy];
    if (!pick) throw new Error("missing quote");
    await db.shippingLabel.create({
      data: {
        packageId: pkg.id,
        status: "ACTIVE",
        provider: "SHIPSTATION",
        idempotencyKey: `export-${++key}`,
        carrierCode: "ups",
        serviceCode: pick.serviceCode,
        carrierId: pick.carrierId,
        serviceId: pick.serviceId,
        costCents: pick.amountCents,
        quotedAmountCents: pick.amountCents,
        currency: "USD",
        purchasedAt: new Date(purchasedAt),
        rateQuoteId: pick.id,
        selectionReason: reason,
      },
    });
  }

  it("writes every quote of each package in the filters, newest first, reason on the bought one", async () => {
    const { ground, air } = await services();
    await bought(
      "1001",
      "TX",
      [quote(ground, 700, 5), quote(air, 2000, 1)],
      1,
      "FASTER_DELIVERY",
      "2026-11-01T10:00:00Z",
    );
    await bought("1002", "TX", [quote(ground, 650, 5)], 0, null, "2026-11-02T10:00:00Z");
    await bought("1003", "CA", [quote(ground, 800, 4)], 0, null, "2026-11-02T11:00:00Z");

    const admin = await createActor(db, ["ADMIN"]);
    const csv = await realOrdersCsv(
      db,
      admin,
      { from: "2026-10-01", to: "2026-11-03", state: "TX" },
      { now },
    );
    expect(csv.filename).toBe("real-orders-2026-10-01-2026-11-03.csv");
    expect((await text(csv)).split("\r\n")).toEqual([
      "Order,Package,Purchased at,Lane,Parcel,Provider,Carrier,Service,Amount,Currency,Delivery days,Cheapest,Bought,Reason",
      '1002,1,2026-11-02T10:00:00.000Z,US-TX,Box 1002,SHIPSTATION,"UPS, main",Ground,6.5,USD,5,yes,yes,',
      '1001,1,2026-11-01T10:00:00.000Z,US-TX,Box 1001,SHIPSTATION,"UPS, main",Ground,7,USD,5,yes,no,',
      '1001,1,2026-11-01T10:00:00.000Z,US-TX,Box 1001,SHIPSTATION,"UPS, main","Next ""Day"" Air",20,USD,1,no,yes,FASTER_DELIVERY',
      "",
    ]);

    // Without filters, the last 30 days and every lane.
    const all = await text(await realOrdersCsv(db, admin, {}, { now }));
    expect(all.split("\r\n").filter((line) => line.startsWith("1003,"))).toHaveLength(1);
  });

  it("needs report.read, which a Rate Lab user doesn't have, and refuses bad filters", async () => {
    const lab = await createActor(db, ["RATE_LAB"]);
    await expect(realOrdersCsv(db, lab, {}, { now })).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
    const admin = await createActor(db, ["ADMIN"]);
    await expect(
      realOrdersCsv(db, admin, { from: "2026-11-02", to: "2026-11-01" }, { now }),
    ).rejects.toMatchObject({ kind: "BAD_REQUEST" });
  });
});
