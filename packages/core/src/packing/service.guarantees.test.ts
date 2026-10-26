import { MAX_PACKAGES_PER_ORDER } from "@woolrus/contracts";
import type { Db } from "@woolrus/db";
import pg from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder, type LineSpec } from "../../test/factories";
import { archiveBox } from "../boxes/service";
import type { UserActor } from "../permissions";
import { ORDER_CHANGED_CHANNEL } from "../workflow/notify";
import { getPackView } from "./queries";
import {
  addPackage,
  deletePackage,
  packRemaining,
  packUnits,
  scanIntoPackage,
  setPackageBox,
  setWeight,
  unpackUnits,
} from "./service";

// What every package write promises (SPEC-packing success criteria 1, 8, 13): refused changes
// nothing, a good write records itself once, and a changed package loses what depended on it.

const db: Db = testDb();
let listener: pg.Client;
let notified: { id: string; status: string }[];

afterAll(() => db.$disconnect());
beforeEach(async () => {
  await resetDb(db);
  notified = [];
  listener = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await listener.connect();
  listener.on("notification", (msg) => notified.push(JSON.parse(msg.payload ?? "null")));
  await listener.query(`LISTEN ${ORDER_CHANGED_CHANNEL}`);
});
afterEach(() => listener.end());

const settle = () => new Promise((resolve) => setTimeout(resolve, 200));
const key = () => crypto.randomUUID();
const id = (row: { id: string } | undefined) => row?.id as string;

/** A Packing order claimed by a fresh packer, with two packages and 2 of 3 units in the first. */
async function setup(lines: LineSpec[] = [{ sku: "AAA-1", quantity: 3 }]) {
  const packer = await createActor(db, ["PACKER"]);
  const built = await createOrder(db, {
    status: "PACKING",
    version: 3,
    claimedById: packer.userId,
    claimedAt: new Date(),
    lines: lines.map((l) => ({ pickStatus: "PICKED" as const, ...l })),
  });
  const box = await db.box.create({
    data: { name: "Medium", lengthIn: 12, widthIn: 10, heightIn: 8, maxWeightOz: 400 },
  });
  const add = () =>
    addPackage(db, packer, {
      orderId: built.order.id,
      box: { boxId: box.id },
      idempotencyKey: key(),
    });
  await add();
  const { packages } = await add();
  const [first, second] = packages;
  await packUnits(db, packer, {
    packageId: id(first),
    orderItemId: id(built.items[0]),
    quantity: Math.min(2, built.items[0]?.quantity ?? 1),
  });
  await setWeight(db, packer, { packageId: id(first), weightOz: 30 });
  return { packer, box, ...built, first: id(first), second: id(second), add };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

/** Every package write, called the way the router does, on the first (weighed) package. */
const ops: [string, string, (actor: UserActor, c: Ctx) => Promise<unknown>][] = [
  [
    "addPackage",
    "add",
    (a, c) =>
      addPackage(db, a, { orderId: c.order.id, box: { boxId: c.box.id }, idempotencyKey: key() }),
  ],
  [
    "setPackageBox",
    "setBox",
    (a, c) =>
      setPackageBox(db, a, { packageId: c.first, box: { lengthIn: 5, widthIn: 5, heightIn: 5 } }),
  ],
  ["deletePackage", "delete", (a, c) => deletePackage(db, a, { packageId: c.second })],
  [
    "packUnits",
    "packUnits",
    (a, c) => packUnits(db, a, { packageId: c.first, orderItemId: id(c.items[0]) }),
  ],
  [
    "unpackUnits",
    "unpackUnits",
    (a, c) => unpackUnits(db, a, { packageId: c.first, orderItemId: id(c.items[0]) }),
  ],
  ["packRemaining", "packRemaining", (a, c) => packRemaining(db, a, { packageId: c.first })],
  ["setWeight", "setWeight", (a, c) => setWeight(db, a, { packageId: c.first, weightOz: 31 })],
  [
    "scanIntoPackage",
    "scan",
    (a, c) => scanIntoPackage(db, a, { packageId: c.first, code: "AAA-1", scanId: key() }),
  ],
];

/** Everything a refused write must leave alone. */
async function state(orderId: string) {
  return {
    packages: await db.package.findMany({ where: { orderId }, orderBy: { number: "asc" } }),
    items: await db.packageItem.findMany({ orderBy: { id: "asc" } }),
    rates: await db.shippingRate.count(),
    audit: await db.auditEvent.count(),
    idempotent: await db.idempotentRequest.count(),
    order: await db.order.findUniqueOrThrow({ where: { id: orderId } }),
  };
}

describe("a refused write changes nothing and tells no one", () => {
  const refusals: [string, (c: Ctx) => Promise<void>, string][] = [
    [
      "the order isn't Packing",
      (c) => db.order.update({ where: { id: c.order.id }, data: { status: "QA" } }).then(() => {}),
      "errors.packing.notPacking",
    ],
    [
      "the claim expired",
      (c) =>
        db.order
          .update({
            where: { id: c.order.id },
            data: { claimedAt: new Date(Date.now() - 24 * 3_600_000) },
          })
          .then(() => {}),
      "errors.workflow.claimRequired",
    ],
    [
      "another packer took the order over",
      async (c) => {
        const other = await createActor(db, ["PACKER"]);
        await db.order.update({
          where: { id: c.order.id },
          data: { claimedById: other.userId, claimedAt: new Date() },
        });
      },
      "errors.workflow.claimRequired",
    ],
  ];

  for (const [why, arrange, messageKey] of refusals) {
    it.each(ops)(`%s: refused when ${why}`, async (_name, _action, run) => {
      const c = await setup();
      await arrange(c);
      const before = await state(c.order.id);
      await settle();
      notified.length = 0;

      await expect(run(c.packer, c)).rejects.toMatchObject({ kind: "CONFLICT", messageKey });

      await settle();
      expect(await state(c.order.id)).toEqual(before);
      expect(notified).toEqual([]);
    });
  }

  it.each(ops)("%s: refused for a Picker, changing nothing", async (_name, _action, run) => {
    const c = await setup();
    const picker = await createActor(db, ["PICKER"]);
    const before = await state(c.order.id);

    await expect(run(picker, c)).rejects.toMatchObject({ kind: "FORBIDDEN" });

    expect(await state(c.order.id)).toEqual(before);
  });
});

describe("a good write records itself once", () => {
  it.each(ops)(
    "%s: one audit event, one notification, the version untouched",
    async (_n, action, run) => {
      const c = await setup();
      await settle();
      notified.length = 0;
      const auditBefore = await db.auditEvent.count();
      const version = (await db.order.findUniqueOrThrow({ where: { id: c.order.id } })).version;

      await run(c.packer, c);
      await settle();

      const events = (await db.auditEvent.findMany({ orderBy: { at: "asc" } })).slice(auditBefore);
      expect(events.map((e) => e.action)).toEqual([`package.${action}`]);
      expect(events[0]).toMatchObject({ entityType: "Package", actorId: c.packer.userId });
      // Before and after: an add has no before, a delete has no after.
      expect(events[0]?.before == null).toBe(action === "add");
      expect(events[0]?.after == null).toBe(action === "delete");
      expect(notified).toEqual([{ id: c.order.id, status: "PACKING" }]);
      expect((await db.order.findUniqueOrThrow({ where: { id: c.order.id } })).version).toBe(
        version,
      );
    },
  );
});

describe("a changed package loses what depended on it", () => {
  async function withRateAndQa(c: Ctx, packageId: string) {
    await db.packageItem.updateMany({
      where: { packageId },
      data: { qaVerifiedAt: new Date(), qaVerifiedById: c.packer.userId },
    });
    for (const target of [c.first, c.second]) {
      await db.shippingRate.create({
        data: {
          packageId: target,
          shipstationRateId: `r-${target}`,
          carrierCode: "usps",
          serviceCode: "ground",
          serviceName: "Ground",
          amountCents: 500,
          currency: "USD",
        },
      });
    }
    await db.shippingLabel.create({
      data: {
        packageId,
        status: "VOIDED",
        idempotencyKey: key(),
        carrierCode: "usps",
        serviceCode: "ground",
        currency: "USD",
      },
    });
  }

  it.each([
    [
      "unpackUnits",
      (c: Ctx) => unpackUnits(db, c.packer, { packageId: c.first, orderItemId: id(c.items[0]) }),
    ],
    [
      "packUnits",
      (c: Ctx) => packUnits(db, c.packer, { packageId: c.first, orderItemId: id(c.items[0]) }),
    ],
    ["packRemaining", (c: Ctx) => packRemaining(db, c.packer, { packageId: c.first })],
    [
      "scanIntoPackage",
      (c: Ctx) =>
        scanIntoPackage(db, c.packer, { packageId: c.first, code: "AAA-1", scanId: key() }),
    ],
  ])(
    "%s: deletes its rates and clears QA verification, not the label or another package's rates",
    async (_n, change) => {
      const c = await setup();
      await withRateAndQa(c, c.first);

      await change(c);

      expect(await db.shippingRate.count({ where: { packageId: c.first } })).toBe(0);
      expect(await db.shippingRate.count({ where: { packageId: c.second } })).toBe(1);
      expect(
        await db.packageItem.count({ where: { packageId: c.first, qaVerifiedAt: { not: null } } }),
      ).toBe(0);
      expect(await db.shippingLabel.count({ where: { packageId: c.first } })).toBe(1);
    },
  );

  it("setWeight with a new weight deletes the rates but keeps QA verification and the label", async () => {
    const c = await setup();
    await withRateAndQa(c, c.first);

    await setWeight(db, c.packer, { packageId: c.first, weightOz: 44 });

    expect(await db.shippingRate.count({ where: { packageId: c.first } })).toBe(0);
    expect(
      await db.packageItem.count({ where: { packageId: c.first, qaVerifiedAt: { not: null } } }),
    ).toBe(1);
    expect(await db.shippingLabel.count({ where: { packageId: c.first } })).toBe(1);
  });

  it("choosing the same box again changes nothing: no audit, rates kept, weight not flagged", async () => {
    const c = await setup();
    await withRateAndQa(c, c.first);
    const audit = await db.auditEvent.count();

    await setPackageBox(db, c.packer, { packageId: c.first, box: { boxId: c.box.id } });

    expect(await db.auditEvent.count()).toBe(audit);
    expect(await db.shippingRate.count({ where: { packageId: c.first } })).toBe(1);
    expect((await db.package.findUniqueOrThrow({ where: { id: c.first } })).weightStale).toBe(
      false,
    );
  });
});

describe("a package keeps an archived box", () => {
  it("lists it on the package but not among the boxes to choose, and still applies its max", async () => {
    const c = await setup();
    await archiveBox(db, await createActor(db, ["ADMIN"]), { id: c.box.id });

    const view = await getPackView(db, c.packer, { orderId: c.order.id });

    expect(view.boxes).toEqual([]);
    expect(view.packages[0]?.box).toMatchObject({
      id: c.box.id,
      name: "Medium",
      inUse: true,
      archived: true,
    });
    await expect(
      setPackageBox(db, c.packer, { packageId: c.second, box: { boxId: c.box.id } }),
    ).rejects.toMatchObject({
      messageKey: "errors.packing.boxArchived",
    });
    await expect(
      setWeight(db, c.packer, { packageId: c.first, weightOz: 401 }),
    ).rejects.toMatchObject({
      messageKey: "errors.packing.overweight",
      params: { maxOz: 400 },
    });
  });
});

describe("replays", () => {
  const input = (c: Ctx, idempotencyKey: string) => ({
    orderId: c.order.id,
    box: { boxId: c.box.id },
    idempotencyKey,
  });

  it("addPackage answers a replay after the order moved on, without adding", async () => {
    const c = await setup();
    const k = key();
    await addPackage(db, c.packer, input(c, k));
    await db.order.update({ where: { id: c.order.id }, data: { status: "QA" } });

    const replay = await addPackage(db, c.packer, input(c, k));

    expect(replay.packages).toHaveLength(3);
    expect(await db.package.count({ where: { orderId: c.order.id } })).toBe(3);
  });

  it("addPackage refuses a key replayed for another order, and answers nothing about it", async () => {
    const c = await setup();
    const k = key();
    await addPackage(db, c.packer, input(c, k));
    const elsewhere = await createOrder(db, { status: "PACKING", lines: [{ sku: "ZZZ-9" }] });

    await expect(
      addPackage(db, c.packer, { ...input(c, k), orderId: elsewhere.order.id }),
    ).rejects.toMatchObject({ kind: "CONFLICT" });
  });

  it("addPackage with the same key sent twice at once adds one package", async () => {
    const c = await setup();
    const k = key();

    const results = await Promise.all([
      addPackage(db, c.packer, input(c, k)),
      addPackage(db, c.packer, input(c, k)),
    ]);

    expect(results.map((r) => r.packages.length)).toEqual([3, 3]);
    expect(await db.package.count({ where: { orderId: c.order.id } })).toBe(3);
  });

  it("a scan replayed after its line is fully packed is answered, not refused", async () => {
    // The only unit goes into the first package at setup; a second line is scanned into the second.
    const c = await setup([
      { sku: "ONE-1", quantity: 1 },
      { sku: "TWO-2", quantity: 1 },
    ]);
    const scanId = key();
    await scanIntoPackage(db, c.packer, { packageId: c.second, code: "TWO-2", scanId });

    const replay = await scanIntoPackage(db, c.packer, {
      packageId: c.second,
      code: "TWO-2",
      scanId,
    });

    expect(replay.lines.every((l) => l.unassigned === 0)).toBe(true);
    expect(await db.packageItem.aggregate({ _sum: { quantity: true } })).toMatchObject({
      _sum: { quantity: 2 },
    });
  });

  it("a scanId another packer already used is refused", async () => {
    const c = await setup();
    const scanId = key();
    await scanIntoPackage(db, c.packer, { packageId: c.first, code: "AAA-1", scanId });
    const other = await createActor(db, ["PACKER"]);

    await expect(
      scanIntoPackage(db, other, { packageId: c.first, code: "AAA-1", scanId }),
    ).rejects.toMatchObject({ kind: "CONFLICT", messageKey: "errors.conflict" });
  });
});

describe("limits and views", () => {
  it(`stops at ${MAX_PACKAGES_PER_ORDER} packages per order`, async () => {
    const c = await setup();
    const have = await db.package.count({ where: { orderId: c.order.id } });
    await db.package.createMany({
      data: Array.from({ length: MAX_PACKAGES_PER_ORDER - have }, (_, i) => ({
        orderId: c.order.id,
        number: have + i + 1,
        boxId: c.box.id,
      })),
    });

    await expect(c.add()).rejects.toMatchObject({
      messageKey: "errors.packing.tooManyPackages",
      params: { max: MAX_PACKAGES_PER_ORDER },
    });
    expect(await db.package.count({ where: { orderId: c.order.id } })).toBe(MAX_PACKAGES_PER_ORDER);
  });

  it("units voided after packing leave the line over-packed and the gate unmet", async () => {
    const c = await setup();
    await db.itemVoid.create({
      data: {
        orderId: c.order.id,
        orderItemId: id(c.items[0]),
        quantity: 2,
        reason: "void",
        stage: "PICKING",
      },
    });

    const view = await getPackView(db, c.packer, { orderId: c.order.id });

    expect(view.lines[0]).toMatchObject({ quantity: 1, tooMany: 1 });
    expect(view.unmet.map((u) => u.messageKey)).toContain("errors.workflow.gate.lineOverPacked");
  });

  it("the view is readable by anyone who can read orders, whoever holds the claim and whatever the status", async () => {
    const c = await setup();
    const picker = await createActor(db, ["PICKER"]);
    await db.order.update({ where: { id: c.order.id }, data: { status: "QA", claimedById: null } });

    const view = await getPackView(db, picker, { orderId: c.order.id });

    expect(view.order).toMatchObject({ status: "QA", claim: null });
    expect(view.packages).toHaveLength(2);
  });
});

describe("a box archived while a package is being added to it", () => {
  it("is refused as archived: the add waits for the archive instead of reading around it", async () => {
    const c = await setup();
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let archived!: () => void;
    const isArchived = new Promise<void>((resolve) => {
      archived = resolve;
    });
    // An admin's archive, mid-transaction: the box is archived but it isn't committed yet.
    const archiving = db.$transaction(
      async (tx) => {
        await tx.box.update({ where: { id: c.box.id }, data: { archivedAt: new Date() } });
        archived();
        await released;
      },
      { timeout: 20_000 },
    );
    await isArchived;

    const adding = c.add();
    await settle();
    release();
    await archiving;

    await expect(adding).rejects.toMatchObject({ messageKey: "errors.packing.boxArchived" });
    expect(await db.package.count({ where: { orderId: c.order.id } })).toBe(2);
  });
});
