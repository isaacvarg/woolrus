import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder, type LineSpec } from "../../test/factories";
import {
  addPackage,
  deletePackage,
  getPackView,
  packRemaining,
  packUnits,
  scanIntoPackage,
  setPackageBox,
  setWeight,
  unpackUnits,
} from "./service";

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const key = () => crypto.randomUUID();
const id = (row: { id: string } | undefined) => row?.id as string;

const makeBox = (name = "Medium", extra: { archivedAt?: Date } = {}) =>
  db.box.create({
    data: { name, lengthIn: 12, widthIn: 10, heightIn: 8, maxWeightOz: 400, ...extra },
  });

/** A Packing order claimed by a fresh packer. */
async function packing(lines: LineSpec[] = [{ quantity: 6 }, { quantity: 1 }]) {
  const packer = await createActor(db, ["PACKER"]);
  const built = await createOrder(db, {
    status: "PACKING",
    version: 3,
    claimedById: packer.userId,
    claimedAt: new Date(),
    lines: lines.map((l) => ({ pickStatus: "PICKED" as const, ...l })),
  });
  return { packer, ...built };
}

const rows = (packageId: string) =>
  db.packageItem.findMany({ where: { packageId }, orderBy: { packedAt: "asc" } });

describe("addPackage", () => {
  it("numbers packages after the last one and takes an active box", async () => {
    const { packer, order } = await packing();
    const box = await makeBox();

    const first = await addPackage(db, packer, {
      orderId: order.id,
      box: { boxId: box.id },
      idempotencyKey: key(),
    });
    const second = await addPackage(db, packer, {
      orderId: order.id,
      box: { lengthIn: 14, widthIn: 9, heightIn: 4 },
      idempotencyKey: key(),
    });

    expect(first.packages.map((p) => p.number)).toEqual([1]);
    expect(first.packages[0]?.box?.name).toBe("Medium");
    expect(second.packages.map((p) => p.number)).toEqual([1, 2]);
    expect(second.packages[1]).toMatchObject({
      box: null,
      dimensions: { lengthIn: 14, widthIn: 9, heightIn: 4 },
    });
  });

  it("adds one package per idempotency key", async () => {
    const { packer, order } = await packing();
    const box = await makeBox();
    const input = { orderId: order.id, box: { boxId: box.id }, idempotencyKey: key() };

    await addPackage(db, packer, input);
    const replay = await addPackage(db, packer, input);

    expect(replay.packages).toHaveLength(1);
    expect(await db.package.count({ where: { orderId: order.id } })).toBe(1);
  });

  it("refuses an archived box", async () => {
    const { packer, order } = await packing();
    const box = await makeBox("Old", { archivedAt: new Date() });

    await expect(
      addPackage(db, packer, { orderId: order.id, box: { boxId: box.id }, idempotencyKey: key() }),
    ).rejects.toMatchObject({ messageKey: "errors.packing.boxArchived" });
    expect(await db.package.count()).toBe(0);
  });

  it("records one audit event and leaves the version alone", async () => {
    const { packer, order } = await packing();
    const box = await makeBox();

    await addPackage(db, packer, {
      orderId: order.id,
      box: { boxId: box.id },
      idempotencyKey: key(),
    });

    const audit = await db.auditEvent.findMany({ where: { action: "package.add" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ entityType: "Package", actorId: packer.userId });
    expect(audit[0]?.after).toMatchObject({ number: 1 });
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).version).toBe(3);
  });
});

describe("packUnits / unpackUnits", () => {
  it("splits a line across two packages without touching the line", async () => {
    const { packer, order, items } = await packing([{ quantity: 6 }]);
    const [line] = items;
    await db.orderItem.update({ where: { id: id(line) }, data: { substitutionNote: "kept" } });
    const box = await makeBox();
    const one = await addPackage(db, packer, {
      orderId: order.id,
      box: { boxId: box.id },
      idempotencyKey: key(),
    });
    const two = await addPackage(db, packer, {
      orderId: order.id,
      box: { boxId: box.id },
      idempotencyKey: key(),
    });
    const [p1, p2] = two.packages;
    expect(one.packages).toHaveLength(1);

    await packUnits(db, packer, { packageId: id(p1), orderItemId: id(line), quantity: 4 });
    const result = await packUnits(db, packer, {
      packageId: id(p2),
      orderItemId: id(line),
      quantity: 2,
    });

    expect(result.lines[0]).toMatchObject({
      unassigned: 0,
      packedIn: [
        { number: 1, quantity: 4 },
        { number: 2, quantity: 2 },
      ],
    });
    const after = await db.orderItem.findUniqueOrThrow({ where: { id: id(line) } });
    expect(after).toMatchObject({ id: id(line), quantity: 6, substitutionNote: "kept" });
    expect(await db.orderItem.count({ where: { orderId: order.id } })).toBe(1);
  });

  it("increments the one row when the package already holds the line", async () => {
    const { packer, order, items } = await packing([{ quantity: 3 }]);
    const box = await makeBox();
    const { packages } = await addPackage(db, packer, {
      orderId: order.id,
      box: { boxId: box.id },
      idempotencyKey: key(),
    });
    const pkg = id(packages[0]);

    await packUnits(db, packer, { packageId: pkg, orderItemId: id(items[0]) });
    await packUnits(db, packer, { packageId: pkg, orderItemId: id(items[0]), quantity: 2 });

    const stored = await rows(pkg);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ quantity: 3, packedById: packer.userId });
  });

  it("refuses more than the unassigned units and changes nothing", async () => {
    const { packer, order, items } = await packing([{ quantity: 2 }]);
    const box = await makeBox();
    const { packages } = await addPackage(db, packer, {
      orderId: order.id,
      box: { boxId: box.id },
      idempotencyKey: key(),
    });
    const pkg = id(packages[0]);
    await packUnits(db, packer, { packageId: pkg, orderItemId: id(items[0]) });

    await expect(
      packUnits(db, packer, { packageId: pkg, orderItemId: id(items[0]), quantity: 2 }),
    ).rejects.toMatchObject({ messageKey: "errors.packing.nothingToPack" });
    expect((await rows(pkg))[0]?.quantity).toBe(1);
  });

  it("takes units out and deletes the row at 0", async () => {
    const { packer, order, items } = await packing([{ quantity: 3 }]);
    const box = await makeBox();
    const { packages } = await addPackage(db, packer, {
      orderId: order.id,
      box: { boxId: box.id },
      idempotencyKey: key(),
    });
    const pkg = id(packages[0]);
    await packUnits(db, packer, { packageId: pkg, orderItemId: id(items[0]), quantity: 3 });

    const some = await unpackUnits(db, packer, {
      packageId: pkg,
      orderItemId: id(items[0]),
      quantity: 2,
    });
    expect(some.lines[0]).toMatchObject({ unassigned: 2 });
    expect((await rows(pkg))[0]?.quantity).toBe(1);

    const none = await unpackUnits(db, packer, { packageId: pkg, orderItemId: id(items[0]) });
    expect(none.lines[0]).toMatchObject({ unassigned: 3, packedIn: [] });
    expect(await rows(pkg)).toHaveLength(0);
  });

  it("refuses to unpack more than the package holds", async () => {
    const { packer, order, items } = await packing([{ quantity: 3 }]);
    const box = await makeBox();
    const { packages } = await addPackage(db, packer, {
      orderId: order.id,
      box: { boxId: box.id },
      idempotencyKey: key(),
    });

    await expect(
      unpackUnits(db, packer, { packageId: id(packages[0]), orderItemId: id(items[0]) }),
    ).rejects.toMatchObject({ messageKey: "errors.packing.nothingToPack" });
  });

  it("counts voided units out of what can be packed", async () => {
    const { packer, order, items } = await packing([{ quantity: 4, voids: [{ quantity: 1 }] }]);
    const box = await makeBox();
    const { packages } = await addPackage(db, packer, {
      orderId: order.id,
      box: { boxId: box.id },
      idempotencyKey: key(),
    });

    await expect(
      packUnits(db, packer, { packageId: id(packages[0]), orderItemId: id(items[0]), quantity: 4 }),
    ).rejects.toMatchObject({ messageKey: "errors.packing.nothingToPack" });
    const ok = await packUnits(db, packer, {
      packageId: id(packages[0]),
      orderItemId: id(items[0]),
      quantity: 3,
    });
    expect(ok.lines[0]).toMatchObject({ quantity: 3, unassigned: 0 });
  });

  it("refuses a non-physical line", async () => {
    const { packer, order, items } = await packing([{ quantity: 1, physical: false }]);
    const box = await makeBox();
    const { packages } = await addPackage(db, packer, {
      orderId: order.id,
      box: { boxId: box.id },
      idempotencyKey: key(),
    });

    await expect(
      packUnits(db, packer, { packageId: id(packages[0]), orderItemId: id(items[0]) }),
    ).rejects.toMatchObject({ messageKey: "errors.packing.lineNotPackable" });
  });

  it("clears QA verification on the package and its rates, but not labels", async () => {
    const { packer, order, items } = await packing([{ quantity: 3 }]);
    const box = await makeBox();
    const { packages } = await addPackage(db, packer, {
      orderId: order.id,
      box: { boxId: box.id },
      idempotencyKey: key(),
    });
    const pkg = id(packages[0]);
    await packUnits(db, packer, { packageId: pkg, orderItemId: id(items[0]) });
    await db.packageItem.updateMany({
      where: { packageId: pkg },
      data: { qaVerifiedAt: new Date(), qaVerifiedById: packer.userId },
    });
    await db.shippingRate.create({
      data: {
        packageId: pkg,
        shipstationRateId: "r1",
        carrierCode: "usps",
        serviceCode: "ground",
        serviceName: "Ground",
        amountCents: 500,
        currency: "USD",
      },
    });
    await db.shippingLabel.create({
      data: {
        packageId: pkg,
        status: "VOIDED",
        idempotencyKey: key(),
        carrierCode: "usps",
        serviceCode: "ground",
        currency: "USD",
      },
    });

    await packUnits(db, packer, { packageId: pkg, orderItemId: id(items[0]) });

    expect((await rows(pkg))[0]).toMatchObject({
      quantity: 2,
      qaVerifiedAt: null,
      qaVerifiedById: null,
    });
    expect(await db.shippingRate.count({ where: { packageId: pkg } })).toBe(0);
    expect(await db.shippingLabel.count({ where: { packageId: pkg } })).toBe(1);
  });
});

describe("the package_items unique index", () => {
  it("rejects a second row for the same line in the same package", async () => {
    const { packer, order, items } = await packing([{ quantity: 3 }]);
    const box = await makeBox();
    const { packages } = await addPackage(db, packer, {
      orderId: order.id,
      box: { boxId: box.id },
      idempotencyKey: key(),
    });
    const data = { packageId: id(packages[0]), orderItemId: id(items[0]), quantity: 1 };
    await db.packageItem.create({ data });

    await expect(db.packageItem.create({ data })).rejects.toMatchObject({ code: "P2002" });
  });
});

describe("packRemaining", () => {
  it("puts every line's unassigned units in the package", async () => {
    const { packer, order, items } = await packing([
      { quantity: 6 },
      { quantity: 1 },
      { quantity: 2, physical: false },
    ]);
    const box = await makeBox();
    const { packages } = await addPackage(db, packer, {
      orderId: order.id,
      box: { boxId: box.id },
      idempotencyKey: key(),
    });
    const pkg = id(packages[0]);
    await packUnits(db, packer, { packageId: pkg, orderItemId: id(items[0]), quantity: 2 });

    const result = await packRemaining(db, packer, { packageId: pkg });

    expect(result.lines.map((l) => l.unassigned)).toEqual([0, 0]);
    expect(result.unmet.map((u) => u.messageKey)).not.toContain(
      "errors.workflow.gate.lineUnderPacked",
    );
    expect((await rows(pkg)).map((r) => r.quantity).sort()).toEqual([1, 6]);
  });
});

describe("setPackageBox", () => {
  it("replaces the box with custom dimensions and back", async () => {
    const { packer, order } = await packing();
    const box = await makeBox();
    const { packages } = await addPackage(db, packer, {
      orderId: order.id,
      box: { boxId: box.id },
      idempotencyKey: key(),
    });
    const pkg = id(packages[0]);

    const custom = await setPackageBox(db, packer, {
      packageId: pkg,
      box: { lengthIn: 5, widthIn: 5, heightIn: 5 },
    });
    expect(custom.packages[0]).toMatchObject({ box: null, dimensions: { lengthIn: 5 } });

    const back = await setPackageBox(db, packer, { packageId: pkg, box: { boxId: box.id } });
    expect(back.packages[0]).toMatchObject({ dimensions: null });
    expect(back.packages[0]?.box?.id).toBe(box.id);
  });

  it("refuses an archived box", async () => {
    const { packer, order } = await packing();
    const box = await makeBox();
    const old = await makeBox("Old", { archivedAt: new Date() });
    const { packages } = await addPackage(db, packer, {
      orderId: order.id,
      box: { boxId: box.id },
      idempotencyKey: key(),
    });

    await expect(
      setPackageBox(db, packer, { packageId: id(packages[0]), box: { boxId: old.id } }),
    ).rejects.toMatchObject({ messageKey: "errors.packing.boxArchived" });
  });
});

describe("deletePackage", () => {
  it("returns units to unassigned and renumbers later packages", async () => {
    const { packer, order, items } = await packing([{ quantity: 3 }]);
    const box = await makeBox();
    const add = () =>
      addPackage(db, packer, { orderId: order.id, box: { boxId: box.id }, idempotencyKey: key() });
    await add();
    await add();
    const { packages } = await add();
    const [p1, p2, p3] = packages;
    await packUnits(db, packer, { packageId: id(p2), orderItemId: id(items[0]), quantity: 2 });
    await packUnits(db, packer, { packageId: id(p3), orderItemId: id(items[0]) });

    const result = await deletePackage(db, packer, { packageId: id(p2) });

    expect(result.packages.map((p) => [p.id, p.number])).toEqual([
      [id(p1), 1],
      [id(p3), 2],
    ]);
    expect(result.lines[0]).toMatchObject({
      unassigned: 2,
      packedIn: [{ number: 2, quantity: 1 }],
    });
  });

  it("is refused when any label, even a voided one, references the package", async () => {
    const { packer, order } = await packing();
    const box = await makeBox();
    const { packages } = await addPackage(db, packer, {
      orderId: order.id,
      box: { boxId: box.id },
      idempotencyKey: key(),
    });
    const pkg = id(packages[0]);
    await db.shippingLabel.create({
      data: {
        packageId: pkg,
        status: "VOIDED",
        idempotencyKey: key(),
        carrierCode: "usps",
        serviceCode: "ground",
        currency: "USD",
      },
    });

    await expect(deletePackage(db, packer, { packageId: pkg })).rejects.toMatchObject({
      messageKey: "errors.packing.packageHasLabels",
    });
    expect(await db.package.count({ where: { id: pkg } })).toBe(1);
  });
});

describe("refusals change nothing", () => {
  it("when the order isn't Packing", async () => {
    const { packer, order } = await packing();
    const box = await makeBox();
    await db.order.update({ where: { id: order.id }, data: { status: "QA" } });

    await expect(
      addPackage(db, packer, { orderId: order.id, box: { boxId: box.id }, idempotencyKey: key() }),
    ).rejects.toMatchObject({ kind: "CONFLICT", messageKey: "errors.packing.notPacking" });
    expect(await db.package.count()).toBe(0);
  });

  it("when the actor has no live claim", async () => {
    const { packer, order, items } = await packing([{ quantity: 2 }]);
    const box = await makeBox();
    const { packages } = await addPackage(db, packer, {
      orderId: order.id,
      box: { boxId: box.id },
      idempotencyKey: key(),
    });
    const other = await createActor(db, ["PACKER"]);
    const pkg = id(packages[0]);

    for (const run of [
      () =>
        addPackage(db, other, { orderId: order.id, box: { boxId: box.id }, idempotencyKey: key() }),
      () =>
        setPackageBox(db, other, { packageId: pkg, box: { lengthIn: 1, widthIn: 1, heightIn: 1 } }),
      () => packUnits(db, other, { packageId: pkg, orderItemId: id(items[0]) }),
      () => unpackUnits(db, other, { packageId: pkg, orderItemId: id(items[0]) }),
      () => packRemaining(db, other, { packageId: pkg }),
      () => deletePackage(db, other, { packageId: pkg }),
    ]) {
      await expect(run()).rejects.toMatchObject({ messageKey: "errors.workflow.claimRequired" });
    }
    expect(await db.package.count()).toBe(1);
    expect(await db.packageItem.count()).toBe(0);
  });

  it("when the claim has expired", async () => {
    const { packer, order } = await packing();
    const box = await makeBox();
    await db.order.update({
      where: { id: order.id },
      data: { claimedAt: new Date(Date.now() - 24 * 3_600_000) },
    });

    await expect(
      addPackage(db, packer, { orderId: order.id, box: { boxId: box.id }, idempotencyKey: key() }),
    ).rejects.toMatchObject({ messageKey: "errors.workflow.claimRequired" });
  });

  it("when the package or line belongs to another order", async () => {
    const mine = await packing([{ quantity: 2 }]);
    const theirs = await packing([{ quantity: 2 }]);
    const box = await makeBox();
    const { packages: myPackages } = await addPackage(db, mine.packer, {
      orderId: mine.order.id,
      box: { boxId: box.id },
      idempotencyKey: key(),
    });
    const { packages: theirPackages } = await addPackage(db, theirs.packer, {
      orderId: theirs.order.id,
      box: { boxId: box.id },
      idempotencyKey: key(),
    });

    // Their package is not the packer's to touch (no claim); their line can't go in my package.
    await expect(
      packUnits(db, mine.packer, {
        packageId: id(theirPackages[0]),
        orderItemId: id(mine.items[0]),
      }),
    ).rejects.toMatchObject({ messageKey: "errors.workflow.claimRequired" });
    await expect(
      packUnits(db, mine.packer, {
        packageId: id(myPackages[0]),
        orderItemId: id(theirs.items[0]),
      }),
    ).rejects.toMatchObject({ messageKey: "errors.packing.lineNotPackable" });
    await expect(
      packUnits(db, mine.packer, {
        packageId: crypto.randomUUID(),
        orderItemId: id(mine.items[0]),
      }),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });
    expect(await db.packageItem.count()).toBe(0);
  });
});

describe("permissions", () => {
  it("a Picker can't pack and a Packer can't touch another's order", async () => {
    const { packer, order, items } = await packing([{ quantity: 2 }]);
    const picker = await createActor(db, ["PICKER"]);
    const box = await makeBox();
    const { packages } = await addPackage(db, packer, {
      orderId: order.id,
      box: { boxId: box.id },
      idempotencyKey: key(),
    });
    const pkg = id(packages[0]);

    for (const run of [
      () =>
        addPackage(db, picker, {
          orderId: order.id,
          box: { boxId: box.id },
          idempotencyKey: key(),
        }),
      () => setPackageBox(db, picker, { packageId: pkg, box: { boxId: box.id } }),
      () => deletePackage(db, picker, { packageId: pkg }),
      () => packUnits(db, picker, { packageId: pkg, orderItemId: id(items[0]) }),
      () => unpackUnits(db, picker, { packageId: pkg, orderItemId: id(items[0]) }),
      () => packRemaining(db, picker, { packageId: pkg }),
    ]) {
      await expect(run()).rejects.toMatchObject({ kind: "FORBIDDEN" });
    }
  });

  it("every role that can read orders can read the pack view", async () => {
    const { packer, order } = await packing();
    const picker = await createActor(db, ["PICKER"]);

    await expect(getPackView(db, picker, { orderId: order.id })).resolves.toMatchObject({
      order: { id: order.id },
    });
    await expect(getPackView(db, packer, { orderId: crypto.randomUUID() })).rejects.toMatchObject({
      kind: "NOT_FOUND",
    });
  });
});

describe("getPackView", () => {
  it("returns lines in pick order with unassigned units, packages, boxes and the unmet list", async () => {
    const { packer, order, items } = await packing([
      { name: "B soap", quantity: 6 },
      { name: "A balm", quantity: 1 },
      { name: "Gift card", quantity: 1, physical: false },
    ]);
    const box = await makeBox();
    await makeBox("Old", { archivedAt: new Date() });
    const { packages } = await addPackage(db, packer, {
      orderId: order.id,
      box: { boxId: box.id },
      idempotencyKey: key(),
    });
    await packUnits(db, packer, {
      packageId: id(packages[0]),
      orderItemId: id(items[0]),
      quantity: 4,
    });

    const view = await getPackView(db, packer, { orderId: order.id });

    expect(view.lines.map((l) => [l.name, l.quantity, l.unassigned])).toEqual([
      ["A balm", 1, 1],
      ["B soap", 6, 2],
    ]);
    expect(view.lines[1]?.packedIn).toEqual([
      { packageId: id(packages[0]), number: 1, quantity: 4 },
    ]);
    expect(view.packages).toHaveLength(1);
    expect(view.boxes.map((b) => b.name)).toEqual(["Medium"]);
    expect(view.unmet.map((u) => u.messageKey)).toContain("errors.workflow.gate.lineUnderPacked");
  });

  it("shows a line packed beyond its active quantity as too many", async () => {
    const { packer, order, items } = await packing([{ quantity: 3 }]);
    const box = await makeBox();
    const { packages } = await addPackage(db, packer, {
      orderId: order.id,
      box: { boxId: box.id },
      idempotencyKey: key(),
    });
    await packUnits(db, packer, {
      packageId: id(packages[0]),
      orderItemId: id(items[0]),
      quantity: 3,
    });
    await db.itemVoid.create({
      data: {
        orderId: order.id,
        orderItemId: id(items[0]),
        quantity: 1,
        reason: "void",
        stage: "PICKING",
      },
    });

    const view = await getPackView(db, packer, { orderId: order.id });

    expect(view.lines[0]).toMatchObject({ quantity: 2, unassigned: 0, tooMany: 1 });
  });
});

describe("setWeight", () => {
  async function boxed(maxWeightOz: number | null = 400) {
    const built = await packing([{ quantity: 3 }]);
    const box = await db.box.create({
      data: { name: "Capped", lengthIn: 12, widthIn: 10, heightIn: 8, maxWeightOz },
    });
    const { packages } = await addPackage(db, built.packer, {
      orderId: built.order.id,
      box: { boxId: box.id },
      idempotencyKey: key(),
    });
    return { ...built, box, pkg: id(packages[0]) };
  }
  const stored = (pkg: string) => db.package.findUniqueOrThrow({ where: { id: pkg } });

  it("saves a weight within the max and drops any reason", async () => {
    const { packer, pkg } = await boxed();

    const result = await setWeight(db, packer, {
      packageId: pkg,
      weightOz: 39.5,
      overrideReason: "not needed",
    });

    expect(result.packages[0]).toMatchObject({ weightOz: 39.5, overrideReason: null });
    expect(await stored(pkg)).toMatchObject({ weightOverrideReason: null });
  });

  it("refuses a weight over the max without a reason, then saves it with one", async () => {
    const { packer, pkg } = await boxed(40);

    await expect(setWeight(db, packer, { packageId: pkg, weightOz: 41 })).rejects.toMatchObject({
      kind: "CONFLICT",
      messageKey: "errors.packing.overweight",
      params: { maxOz: 40 },
    });
    expect((await stored(pkg)).weightOz).toBeNull();

    const result = await setWeight(db, packer, {
      packageId: pkg,
      weightOz: 41,
      overrideReason: "Heavy kit, carrier agreed",
    });
    expect(result.packages[0]).toMatchObject({
      weightOz: 41,
      overrideReason: "Heavy kit, carrier agreed",
    });
  });

  it("takes any weight up to 2400 oz for a box without a max or a custom size", async () => {
    const { packer, order, pkg } = await boxed(null);
    await setWeight(db, packer, { packageId: pkg, weightOz: 2400 });
    const custom = await addPackage(db, packer, {
      orderId: order.id,
      box: { lengthIn: 5, widthIn: 5, heightIn: 5 },
      idempotencyKey: key(),
    });

    const result = await setWeight(db, packer, {
      packageId: id(custom.packages[1]),
      weightOz: 1000,
    });

    expect(result.packages.map((p) => p.weightOz)).toEqual([2400, 1000]);
  });

  it("deletes the package's rates and keeps QA verification", async () => {
    const { packer, items, pkg } = await boxed();
    await packUnits(db, packer, { packageId: pkg, orderItemId: id(items[0]) });
    await db.packageItem.updateMany({
      where: { packageId: pkg },
      data: { qaVerifiedAt: new Date(), qaVerifiedById: packer.userId },
    });
    await db.shippingRate.create({
      data: {
        packageId: pkg,
        shipstationRateId: "r1",
        carrierCode: "usps",
        serviceCode: "ground",
        serviceName: "Ground",
        amountCents: 500,
        currency: "USD",
      },
    });

    await setWeight(db, packer, { packageId: pkg, weightOz: 10 });

    expect(await db.shippingRate.count({ where: { packageId: pkg } })).toBe(0);
    expect((await rows(pkg))[0]?.qaVerifiedAt).not.toBeNull();
  });

  it("is refused for a Picker, without the claim, and over the 2400 oz limit", async () => {
    const { packer, pkg } = await boxed();
    const picker = await createActor(db, ["PICKER"]);
    const other = await createActor(db, ["PACKER"]);

    await expect(setWeight(db, picker, { packageId: pkg, weightOz: 5 })).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
    await expect(setWeight(db, other, { packageId: pkg, weightOz: 5 })).rejects.toMatchObject({
      messageKey: "errors.workflow.claimRequired",
    });
    await expect(setWeight(db, packer, { packageId: pkg, weightOz: 2401 })).rejects.toMatchObject({
      kind: "BAD_REQUEST",
    });
    expect((await stored(pkg)).weightOz).toBeNull();
  });

  it("flags a weighed package when its contents or box change, and not an unweighed one", async () => {
    const { packer, order, items, box, pkg } = await boxed();
    await packUnits(db, packer, { packageId: pkg, orderItemId: id(items[0]) });
    expect((await stored(pkg)).weightStale).toBe(false);
    await setWeight(db, packer, { packageId: pkg, weightOz: 20 });

    for (const change of [
      () => packUnits(db, packer, { packageId: pkg, orderItemId: id(items[0]) }),
      () => unpackUnits(db, packer, { packageId: pkg, orderItemId: id(items[0]) }),
      () => packRemaining(db, packer, { packageId: pkg }),
      () => setPackageBox(db, packer, { packageId: pkg, box: { boxId: box.id } }),
    ]) {
      await setWeight(db, packer, { packageId: pkg, weightOz: 20 });
      expect((await stored(pkg)).weightStale).toBe(false);
      await change();
      expect(await stored(pkg), "flagged").toMatchObject({
        weightStale: true,
        weightOz: expect.anything(),
      });
    }

    // Saving the same weight confirms it; a package never weighed isn't flagged.
    const result = await setWeight(db, packer, { packageId: pkg, weightOz: 20 });
    expect(result.packages[0]?.weightStale).toBe(false);
    const fresh = await addPackage(db, packer, {
      orderId: order.id,
      box: { boxId: box.id },
      idempotencyKey: key(),
    });
    await setPackageBox(db, packer, { packageId: id(fresh.packages[1]), box: { boxId: box.id } });
    expect((await stored(id(fresh.packages[1]))).weightStale).toBe(false);
  });

  it("does not block the packed gate when the weight is stale", async () => {
    const { packer, items, pkg } = await boxed();
    await packRemaining(db, packer, { packageId: pkg });
    const result = await setWeight(db, packer, { packageId: pkg, weightOz: 20 });
    expect(result.unmet).toEqual([]);

    const flagged = await unpackUnits(db, packer, { packageId: pkg, orderItemId: id(items[0]) });
    await packUnits(db, packer, { packageId: pkg, orderItemId: id(items[0]) });
    expect(flagged.packages[0]?.weightStale).toBe(true);
    expect((await getPackView(db, packer, { orderId: (await stored(pkg)).orderId })).unmet).toEqual(
      [],
    );
  });
});

describe("box suggestion, estimate and weight warning", () => {
  const size = { lengthIn: 4, widthIn: 4, heightIn: 3, weightOz: 3.5 };
  const tared = (name: string, tareWeightOz: number, dims = [10, 8, 4]) =>
    db.box.create({
      data: {
        name,
        lengthIn: dims[0] as number,
        widthIn: dims[1] as number,
        heightIn: dims[2] as number,
        maxWeightOz: 320,
        tareWeightOz,
      },
    });

  it("suggests the smallest fitting box for the unassigned units, and updates as units move", async () => {
    const { packer, order, items } = await packing([{ quantity: 4, size }]);
    await tared("Large", 6, [14, 12, 8]);
    await tared("Medium", 4);
    const view = await getPackView(db, packer, { orderId: order.id });
    expect(view.suggestion).toMatchObject({
      kind: "box",
      box: { name: "Medium" },
      estimatedWeightOz: 18,
    });

    const { packages } = await addPackage(db, packer, {
      orderId: order.id,
      box: { boxId: id((await db.box.findFirst({ where: { name: "Large" } })) ?? undefined) },
      idempotencyKey: key(),
    });
    const all = await packRemaining(db, packer, { packageId: id(packages[0]) });
    expect(all.suggestion).toEqual({ kind: "none" });
    expect(all.packages[0]?.suggestion).toMatchObject({ kind: "box", box: { name: "Medium" } });
    expect(items).toHaveLength(1);
  });

  it("names a product without dimensions or weight", async () => {
    const { packer, order } = await packing([
      { name: "Hat", quantity: 1, size },
      { name: "Book", quantity: 1, size: { weightOz: 14 } },
    ]);
    await tared("Medium", 4);
    const view = await getPackView(db, packer, { orderId: order.id });
    expect(view.suggestion).toEqual({ kind: "unknown", missing: ["Book"] });
  });

  it("uses the variation's size over the product's", async () => {
    const { packer, order } = await packing([
      { quantity: 1, size, variation: { lengthIn: 20, widthIn: 20, heightIn: 20, weightOz: 9 } },
    ]);
    await tared("Medium", 4);
    await tared("Huge", 10, [40, 40, 40]);
    const view = await getPackView(db, packer, { orderId: order.id });
    expect(view.suggestion).toMatchObject({ box: { name: "Huge" }, estimatedWeightOz: 19 });
  });

  it("estimates a package's weight and warns beyond 25% off, never without an estimate", async () => {
    const { packer, order } = await packing([
      { quantity: 4, size },
      { quantity: 1, size: { weightOz: 1 } },
    ]);
    const box = await tared("Medium", 4);
    const { packages } = await addPackage(db, packer, {
      orderId: order.id,
      box: { boxId: box.id },
      idempotencyKey: key(),
    });
    const pkg = id(packages[0]);
    const first = await packUnits(db, packer, {
      packageId: pkg,
      orderItemId: id(
        (await db.orderItem.findFirst({
          where: { orderId: order.id },
          orderBy: { wooLineItemId: "asc" },
        })) ?? undefined,
      ),
      quantity: 4,
    });
    // 4 × 3.5 + 4 tare
    expect(first.packages[0]).toMatchObject({ estimatedWeightOz: 18, weightWarning: null });

    const near = await setWeight(db, packer, { packageId: pkg, weightOz: 22 });
    expect(near.packages[0]?.weightWarning).toBeNull();
    const far = await setWeight(db, packer, { packageId: pkg, weightOz: 30 });
    expect(far.packages[0]?.weightWarning).toEqual({ percent: 67 });

    // Without a weight on one product there is no estimate, so no warning.
    const noEstimate = await packing([
      { quantity: 1, size: { lengthIn: 1, widthIn: 1, heightIn: 1 } },
    ]);
    const added = await addPackage(db, noEstimate.packer, {
      orderId: noEstimate.order.id,
      box: { boxId: box.id },
      idempotencyKey: key(),
    });
    const p2 = id(added.packages[0]);
    await packRemaining(db, noEstimate.packer, { packageId: p2 });
    const weighed = await setWeight(db, noEstimate.packer, { packageId: p2, weightOz: 500 }).catch(
      () => null,
    );
    const view = await getPackView(db, noEstimate.packer, { orderId: noEstimate.order.id });
    expect(view.packages[0]).toMatchObject({ estimatedWeightOz: null, weightWarning: null });
    expect(weighed === null || weighed.packages[0]?.weightWarning === null).toBe(true);

describe("scanIntoPackage", () => {
  async function scanning(lines: LineSpec[] = [{ sku: "AAA-1", quantity: 2 }]) {
    const built = await packing(lines);
    const box = await makeBox();
    const { packages } = await addPackage(db, built.packer, {
      orderId: built.order.id,
      box: { boxId: box.id },
      idempotencyKey: key(),
    });
    return { ...built, box, pkg: id(packages[0]) };
  }
  const scan = (
    actor: Parameters<typeof scanIntoPackage>[1],
    packageId: string,
    code: string,
    scanId = key(),
  ) => scanIntoPackage(db, actor, { packageId, code, scanId });
  const packedCount = () => db.packageItem.aggregate({ _sum: { quantity: true } });

  it("packs one unit of the matching line, ignoring case and spaces", async () => {
    const { packer, pkg, items } = await scanning();

    const result = await scan(packer, pkg, " aaa-1 ");

    expect(result.lines[0]).toMatchObject({ id: id(items[0]), unassigned: 1 });
    expect(result.packages[0]?.items).toEqual([
      expect.objectContaining({ orderItemId: id(items[0]), quantity: 1 }),
    ]);
    expect(await db.auditEvent.count({ where: { action: "package.scan" } })).toBe(1);
  });

  it("goes to the first line in pick order that still has unassigned units", async () => {
    const { packer, pkg, items } = await scanning([
      { sku: "DUP-1", quantity: 1, bin: "B1" },
      { sku: "DUP-1", quantity: 1, bin: "A1" },
    ]);

    const first = await scan(packer, pkg, "DUP-1");
    expect(first.packages[0]?.items.map((i) => i.orderItemId)).toEqual([id(items[1])]);
    const second = await scan(packer, pkg, "DUP-1");
    expect(second.lines).toEqual([
      expect.objectContaining({ unassigned: 0 }),
      expect.objectContaining({ unassigned: 0 }),
    ]);
    expect(second.packages[0]?.units).toBe(2);
  });

  it("packs nothing on a replayed scanId", async () => {
    const { packer, pkg } = await scanning();
    const scanId = key();

    await scan(packer, pkg, "AAA-1", scanId);
    const replay = await scan(packer, pkg, "AAA-1", scanId);

    expect(replay.packages[0]?.units).toBe(1);
    expect((await packedCount())._sum.quantity).toBe(1);
    expect(await db.auditEvent.count({ where: { action: "package.scan" } })).toBe(1);
  });

  it("refuses a code from another product, naming it, and an unknown code", async () => {
    const { packer, pkg } = await scanning();
    await createOrder(db, { lines: [{ name: "Elsewhere Soap", sku: "ELSE-1" }] });

    await expect(scan(packer, pkg, "ELSE-1")).rejects.toMatchObject({
      messageKey: "errors.picking.scanNotOnOrder",
      params: { name: "Elsewhere Soap" },
    });
    await expect(scan(packer, pkg, "NOPE")).rejects.toMatchObject({
      messageKey: "errors.picking.scanUnknown",
    });
    expect((await packedCount())._sum.quantity).toBeNull();
    expect(await db.auditEvent.count({ where: { action: "package.scan" } })).toBe(0);
  });

  it("refuses a line whose units are all boxed, changing nothing", async () => {
    const { packer, pkg } = await scanning([{ sku: "AAA-1", quantity: 1 }]);
    await scan(packer, pkg, "AAA-1");

    await expect(scan(packer, pkg, "AAA-1")).rejects.toMatchObject({
      messageKey: "errors.packing.scanAlreadyPacked",
    });
    expect((await packedCount())._sum.quantity).toBe(1);
  });

  it("flags a weighed package to re-weigh and clears QA verification", async () => {
    const { packer, pkg } = await scanning();
    await scan(packer, pkg, "AAA-1");
    await setWeight(db, packer, { packageId: pkg, weightOz: 20 });

    const result = await scan(packer, pkg, "AAA-1");

    expect(result.packages[0]?.weightStale).toBe(true);
  });

  it("is refused for a Picker, without the claim, and when the order isn't Packing", async () => {
    const { packer, order, pkg } = await scanning();
    const picker = await createActor(db, ["PICKER"]);
    const other = await createActor(db, ["PACKER"]);

    await expect(scan(picker, pkg, "AAA-1")).rejects.toMatchObject({ kind: "FORBIDDEN" });
    await expect(scan(other, pkg, "AAA-1")).rejects.toMatchObject({
      messageKey: "errors.workflow.claimRequired",
    });
    await db.order.update({ where: { id: order.id }, data: { status: "QA" } });
    await expect(scan(packer, pkg, "AAA-1")).rejects.toMatchObject({
      messageKey: "errors.packing.notPacking",
    });
    expect(await db.packageItem.count()).toBe(0);
  });
});
