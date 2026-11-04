import type { Db, DbTx, Prisma, ShippingProviderId } from "../src/index";
import {
  demoShipFrom,
  type FakeServiceRow,
  fakeRates,
  fakeShipTo,
  upsertFakeCatalogs,
  upsertProducts,
} from "./seed-orders";

// Rate Lab dev data (SPEC-rate-lab "Dev data"): test addresses, parcels and groups, plus three
// finished suite runs a week apart, so every tab has something to show. Never run in production:
// seed.ts skips it when NODE_ENV=production. Addresses, parcels and runs have fixed ids, so
// re-running skips what exists instead of resetting what someone did to it.

const id = (kind: number, n: number) =>
  `9a1ab000-0000-7000-800${kind}-${String(n).padStart(12, "0")}`;

type DemoAddress = {
  id: string;
  title: string;
  groups: string[];
  name: string;
  company?: string;
  address1: string;
  address2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
};

// Two with "Street" (the fake ShipStation abbreviates it), one Canadian; with a company is commercial.
// biome-ignore format: one address per line reads as a table
const addresses: DemoAddress[] = [
  { id: id(1, 1), title: "Austin house", groups: ["Residential"], name: "Ana Ruiz", address1: "210 Elm Street", city: "Austin", state: "TX", postalCode: "78704", country: "US" },
  { id: id(1, 2), title: "Seattle yarn shop", groups: ["Business"], name: "Sam Lee", company: "Northwind Yarns", address1: "400 Pine Street", city: "Seattle", state: "WA", postalCode: "98101", country: "US" },
  { id: id(1, 3), title: "Brooklyn apartment", groups: ["Residential"], name: "Jo Park", address1: "55 Atlantic Ave", address2: "Apt 3", city: "Brooklyn", state: "NY", postalCode: "11201", country: "US" },
  { id: id(1, 4), title: "Montana ranch", groups: ["Residential"], name: "Lee Hart", address1: "12 Ranch Rd", city: "Bozeman", state: "MT", postalCode: "59715", country: "US" },
  { id: id(1, 5), title: "Miami studio", groups: ["Business"], name: "Rita Gomez", company: "Knit Lab Miami", address1: "900 Biscayne Blvd", city: "Miami", state: "FL", postalCode: "33132", country: "US" },
  { id: id(1, 6), title: "Toronto", groups: ["International"], name: "Chris Tremblay", address1: "100 Queen St W", city: "Toronto", state: "ON", postalCode: "M5H 2N2", country: "CA" },
];

type DemoParcel = {
  id: string;
  title: string;
  groups: string[];
  /** A seeded box to copy the size from; `size` when the box isn't there. */
  box?: string;
  size: [number, number, number];
  weightOz: number;
  /** Contents as [sku, quantity]: the only customs source. */
  items?: [string, number][];
};

// biome-ignore format: one parcel per line reads as a table
const parcels: DemoParcel[] = [
  { id: id(2, 1), title: "Two skeins", groups: ["Everyday"], box: "Small mailer", size: [6, 4, 2], weightOz: 8.5 },
  { id: id(2, 2), title: "Beanie kit", groups: ["Everyday"], box: "Medium box", size: [10, 8, 4], weightOz: 15 },
  { id: id(2, 3), title: "Scarf gift", groups: ["Customs"], size: [10, 6, 2], weightOz: 13, items: [["SCARF-CA-HS", 2]] },
  { id: id(2, 4), title: "Pattern books", groups: ["Heavy"], size: [12, 9, 3], weightOz: 44 },
];

const RUN_WEEKS_AGO = [2, 1, 0];
const runId = (weeksAgo: number) => id(3, RUN_WEEKS_AGO.length - weeksAgo);
const WEEK_MS = 7 * 86_400_000;

/**
 * How much cheaper each service was a week before today's price, so Trends has lines that move.
 * Demo Ground Saver jumped over 10% this week, which the latest run's insights flag.
 */
const weeklyDrift: Record<string, number> = {
  "SHIPSTATION:demo_ground": 0.02,
  "SHIPSTATION:demo_ground_saver": 0.1,
  "SHIPSTATION:demo_express": 0.01,
  "BRIDGE_SOURCE:GND": -0.02,
  "BRIDGE_SOURCE:GNDECO": 0.03,
  "BRIDGE_SOURCE:EXP": 0.015,
};
const drift = (weeksAgo: number) => (row: FakeServiceRow) =>
  1 - weeksAgo * (weeklyDrift[`${row.provider}:${row.service.code}`] ?? 0);

/** The providers a seeded run asked, in the order core lists them. */
const runProviders: ShippingProviderId[] = ["SHIPSTATION", "BRIDGE_SOURCE"];

async function upsertGroups(db: Db, kind: "ADDRESS" | "PARCEL", names: string[]) {
  const ids = new Map<string, string>();
  for (const name of new Set(names)) {
    const found = await db.rateLabGroup.findFirst({
      where: { kind, name: { equals: name, mode: "insensitive" } },
    });
    ids.set(name, found?.id ?? (await db.rateLabGroup.create({ data: { kind, name } })).id);
  }
  return ids;
}

/** Each address as typed, and as the fake ShipStation checked it (or unchecked without the fakes). */
async function seedAddresses(db: Db, fakeShipping: boolean, now: Date) {
  const groups = await upsertGroups(
    db,
    "ADDRESS",
    addresses.flatMap((a) => a.groups),
  );
  for (const { id, title, groups: names, ...typed } of addresses) {
    if (await db.rateLabAddress.findUnique({ where: { id } })) continue;
    const original = typed as Prisma.InputJsonObject;
    const residential = !typed.company;
    const check = fakeShipping
      ? (({ shipTo, shipToStatus, shipToMessages }) => ({
          address: shipTo,
          checkStatus: shipToStatus,
          checkMessages: shipToMessages,
          checkedAt: now,
        }))(fakeShipTo(original, now))
      : {
          address: original,
          checkStatus: "UNCHECKED" as const,
          checkMessages: [],
          checkedAt: null,
        };
    await db.rateLabAddress.create({
      data: {
        id,
        title,
        original,
        residential,
        ...check,
        groups: { create: names.map((name) => ({ groupId: groups.get(name) as string })) },
      },
    });
  }
}

async function seedParcels(db: Db) {
  const groups = await upsertGroups(
    db,
    "PARCEL",
    parcels.flatMap((p) => p.groups),
  );
  const products = await upsertProducts(db);
  for (const parcel of parcels) {
    if (await db.rateLabParcel.findUnique({ where: { id: parcel.id } })) continue;
    const box = parcel.box
      ? await db.box.findFirst({ where: { name: parcel.box, archivedAt: null } })
      : null;
    const [lengthIn, widthIn, heightIn] = parcel.size;
    await db.rateLabParcel.create({
      data: {
        id: parcel.id,
        title: parcel.title,
        ...(box
          ? { boxId: box.id, lengthIn: box.lengthIn, widthIn: box.widthIn, heightIn: box.heightIn }
          : { lengthIn, widthIn, heightIn }),
        weightOz: parcel.weightOz,
        groups: { create: parcel.groups.map((name) => ({ groupId: groups.get(name) as string })) },
        items: {
          create: (parcel.items ?? []).map(([sku, quantity]) => ({
            productId: products.get(sku)?.id as string,
            quantity,
          })),
        },
      },
    });
  }
}

type Address = Prisma.RateLabAddressGetPayload<object>;
type Parcel = Prisma.RateLabParcelGetPayload<{ include: { items: true } }>;

/**
 * One address × parcel as core's lab quoter logs it from both fakes, with domestic services only
 * on (the seeded catalog): abroad, a parcel without contents can't be declared, and one with them
 * finds no international service.
 */
async function logCombination(
  tx: DbTx,
  run: { id: string; shipFrom: typeof demoShipFrom },
  address: Address,
  parcel: Parcel,
  services: FakeServiceRow[],
  at: Date,
  weeksAgo: number,
) {
  const shipTo = address.address as { country: string; state?: string; postalCode: string };
  const international = shipTo.country !== run.shipFrom.country;
  const rates = international
    ? []
    : fakeRates(services, Number(parcel.weightOz), `se-shp-seed-${run.id}`, at, drift(weeksAgo));
  const providerErrors = !international
    ? []
    : parcel.items.length === 0
      ? [
          {
            provider: null,
            messageKey: "errors.shipping.customsIncomplete",
            params: { products: parcel.title },
          },
        ]
      : runProviders.map((provider) => ({ provider, messageKey: "errors.carriers.noCarriers" }));
  await tx.rateFetch.create({
    data: {
      source: "LAB",
      trigger: "LAB_RUN",
      labRunId: run.id,
      labAddressId: address.id,
      labParcelId: parcel.id,
      destCountry: shipTo.country,
      destState: shipTo.state?.trim() || null,
      destZip3: shipTo.postalCode.trim().slice(0, 3) || null,
      residential: address.residential,
      international,
      boxId: parcel.boxId,
      lengthIn: parcel.lengthIn,
      widthIn: parcel.widthIn,
      heightIn: parcel.heightIn,
      weightOz: parcel.weightOz,
      providerErrors,
      fake: true,
      fetchedAt: at,
      quotes: {
        create: rates.map((rate) => ({
          provider: rate.provider,
          carrierId: rate.carrierId,
          serviceId: rate.serviceId,
          carrierCode: rate.carrierCode,
          serviceCode: rate.serviceCode,
          serviceName: rate.serviceName,
          amountCents: rate.amountCents,
          currency: rate.currency,
          deliveryDays: rate.deliveryDays,
          estimatedDeliveryAt: rate.estimatedDeliveryAt,
          guaranteed: rate.guaranteed,
          quoteOnly: false,
          cheapest: rate.selected,
          fake: true,
          createdAt: at,
        })),
      },
    },
  });
  return { quotes: rates.length, failures: providerErrors.length };
}

/** The three suite runs over every seeded address and parcel, oldest first. */
async function seedRuns(db: Db, now: Date) {
  const services = await upsertFakeCatalogs(db);
  const settings = await db.settings.findUnique({ where: { id: 1 } });
  const shipFrom = (settings?.shipFromAddress as typeof demoShipFrom | null) ?? demoShipFrom;
  const seeded = await db.rateLabAddress.findMany({
    where: { id: { in: addresses.map((a) => a.id) } },
    orderBy: { id: "asc" },
  });
  const boxes = await db.rateLabParcel.findMany({
    where: { id: { in: parcels.map((p) => p.id) } },
    include: { items: true },
    orderBy: { id: "asc" },
  });
  let created = 0;
  for (const weeksAgo of RUN_WEEKS_AGO) {
    const id = runId(weeksAgo);
    if (await db.rateLabRun.findUnique({ where: { id } })) continue;
    const startedAt = new Date(now.getTime() - weeksAgo * WEEK_MS - 3_600_000);
    await db.$transaction(
      async (tx) => {
        const run = await tx.rateLabRun.create({
          data: {
            id,
            kind: "SUITE",
            status: "RUNNING",
            selection: { addressGroupIds: [], addressIds: [], parcelGroupIds: [], parcelIds: [] },
            shipFrom,
            combinations: seeded.length * boxes.length,
            fake: true,
            createdAt: startedAt,
            startedAt,
          },
        });
        let at = startedAt;
        let quotes = 0;
        let failures = 0;
        for (const address of seeded) {
          for (const parcel of boxes) {
            at = new Date(at.getTime() + 2_000);
            const logged = await logCombination(
              tx,
              { id: run.id, shipFrom },
              address,
              parcel,
              services,
              at,
              weeksAgo,
            );
            quotes += logged.quotes;
            failures += logged.failures;
          }
        }
        await tx.rateLabRun.update({
          where: { id },
          data: {
            status: failures > 0 ? "PARTIAL" : "SUCCEEDED",
            completedCombinations: seeded.length * boxes.length,
            quoteCount: quotes,
            failureCount: failures,
            heartbeatAt: at,
            finishedAt: at,
          },
        });
        // Quoted, so their physical fields are history (decision 5).
        await tx.rateLabAddress.updateMany({
          where: { id: { in: seeded.map((a) => a.id) }, lockedAt: null },
          data: { lockedAt: startedAt },
        });
        await tx.rateLabParcel.updateMany({
          where: { id: { in: boxes.map((p) => p.id) }, lockedAt: null },
          data: { lockedAt: startedAt },
        });
      },
      { timeout: 30_000 },
    );
    created += 1;
  }
  return created;
}

/**
 * Adds the Rate Lab test addresses, parcels and groups that don't exist yet. With `fakeShipping`
 * (SHIPPING_PROVIDERS=fake) addresses are checked as the fake ShipStation would, and three
 * finished suite runs from both fakes, a week apart, give Trends lines. Returns the runs created.
 */
export async function seedRateLab(
  db: Db,
  { now = new Date(), fakeShipping = false }: { now?: Date; fakeShipping?: boolean } = {},
) {
  await seedAddresses(db, fakeShipping, now);
  await seedParcels(db);
  return fakeShipping ? seedRuns(db, now) : 0;
}
