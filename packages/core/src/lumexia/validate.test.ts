import type { Db, LotStatus } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import { LumexiaAuthError, LumexiaUnavailable } from "../adapters/lumexia/errors";
import { FakeLumexiaClient } from "../adapters/lumexia/fake";
import { enqueue } from "../enqueue";
import { queues } from "../jobs";
import { loadSettings } from "../settings/service";
import { getOrder } from "../workflow/queries";
import { scanLot } from "./lots";
import { runValidateLotsJob, sweepLots, validateLots } from "./validate";

// SPEC-lumexia "Validation": success criteria 9 and 10.

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(async () => {
  await resetDb(db);
  await db.$executeRaw`DELETE FROM pgboss.job WHERE name = ${queues.lumexiaValidateLots}`;
});

const BASE_TYPE = "0190a000-0000-7000-8000-0000000000b1";
const ITEM = "0190a000-0000-7000-8000-00000000a001";
const OTHER = "0190a000-0000-7000-8000-00000000a002";
const NOW = new Date("2026-11-09T12:00:00.000Z");
const minutes = (n: number) => new Date(NOW.getTime() - n * 60_000);
const days = (n: number) => minutes(n * 24 * 60);

/** Lumexia with BASE1234 (the line's item) and OTHER999. */
function lumexia() {
  const fake = new FakeLumexiaClient();
  fake.addItem({ id: ITEM, referenceCode: "BASE1234", itemTypeId: BASE_TYPE });
  fake.addItem({ id: OTHER, referenceCode: "OTHER999", itemTypeId: BASE_TYPE });
  return fake;
}

/** A Packing order whose one box line (3 × BASE1234) needs a lot. */
async function packing() {
  const packer = await createActor(db, ["PACKER"]);
  const built = await createOrder(db, {
    status: "PACKING",
    claimedById: packer.userId,
    lines: [{ quantity: 3, pickStatus: "PICKED", name: "Widget" }],
    packages: [{ items: [{ line: 0, quantity: 3 }], weightOz: 40 }],
  });
  await db.product.update({
    where: { id: built.items[0]?.productId as string },
    data: { lumexiaItemId: ITEM, lumexiaItemRef: "BASE1234", lumexiaItemTypeId: BASE_TYPE },
  });
  const row = await loadSettings(db);
  await db.settings.update({
    where: { id: row.id },
    data: { lumexiaLotItemTypeIds: [BASE_TYPE] },
  });
  const pkg = built.packages[0] as { id: string };
  const boxLine = await db.packageItem.findFirstOrThrow({ where: { packageId: pkg.id } });
  return { packer, ...built, pkg, boxLine };
}

type LotFields = {
  lotNumber?: string | null;
  lumexiaLotId?: string | null;
  status?: LotStatus;
  scannedAt?: Date;
  checkedAt?: Date | null;
  quantity?: number;
  position?: number;
};

async function lot(packageItemId: string, fields: LotFields = {}) {
  return db.packageItemLot.create({
    data: {
      packageItemId,
      lotNumber: "BASE1234.A12A0124",
      quantity: 3,
      position: 0,
      scannedAt: minutes(10),
      ...fields,
    },
  });
}

const reread = (id: string) => db.packageItemLot.findUniqueOrThrow({ where: { id } });
const notes = () => db.note.findMany({ where: { content: { contains: "different item" } } });

async function validateJobs() {
  return db.$queryRaw<{ id: string; ids: string[]; retry_limit: number; retry_delay: number }[]>`
    SELECT id, data->'packageItemLotIds' AS ids, retry_limit, retry_delay FROM pgboss.job
    WHERE name = ${queues.lumexiaValidateLots} ORDER BY created_on`;
}

describe("validateLots", () => {
  it("marks a number on the line's item VALID and fills in its Lumexia id", async () => {
    const { boxLine } = await packing();
    const fake = lumexia();
    const found = fake.addLot({ itemId: ITEM, lotNumber: "BASE1234.A12A0124" });
    const row = await lot(boxLine.id);

    const result = await validateLots(db, fake, [row.id], { now: NOW });

    expect(result).toMatchObject({ valid: 1 });
    expect(await reread(row.id)).toMatchObject({
      status: "VALID",
      lumexiaLotId: found.id,
      lotNumber: "BASE1234.A12A0124",
      checkedAt: NOW,
    });
    expect(fake.calls.map((c) => c.method)).toEqual(["findLotsByNumber"]);
    const audit = await db.auditEvent.findMany({ where: { action: "lot.validate" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      entityType: "PackageItem",
      entityId: boxLine.id,
      actorId: null,
      stationId: null,
    });
    expect(audit[0]?.after).toMatchObject({ lotId: row.id, status: "VALID", by: "lumexia" });
  });

  it("resolves a QR lot by id and fills in its number", async () => {
    const { boxLine } = await packing();
    const fake = lumexia();
    const found = fake.addLot({ itemId: ITEM, lotNumber: "base1234.b07c1124" });
    const row = await lot(boxLine.id, { lotNumber: null, lumexiaLotId: found.id });

    await validateLots(db, fake, [row.id], { now: NOW });

    expect(await reread(row.id)).toMatchObject({
      status: "VALID",
      lotNumber: "BASE1234.B07C1124",
      lumexiaLotId: found.id,
    });
    expect(fake.calls.map((c) => c.method)).toEqual(["getLot"]);
  });

  it("merges a QR lot into the same lot already on the line by number", async () => {
    const { boxLine } = await packing();
    const fake = lumexia();
    const found = fake.addLot({ itemId: ITEM, lotNumber: "BASE1234.A12A0124" });
    const byNumber = await lot(boxLine.id, { quantity: 2 });
    const qr = await lot(boxLine.id, {
      lotNumber: null,
      lumexiaLotId: found.id,
      quantity: 1,
      position: 1,
    });

    await validateLots(db, fake, [qr.id], { now: NOW });

    const rows = await db.packageItemLot.findMany({ where: { packageItemId: boxLine.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: byNumber.id,
      status: "VALID",
      lotNumber: "BASE1234.A12A0124",
      lumexiaLotId: found.id,
      quantity: 3,
      position: 0,
    });
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: "lot.validate" } });
    expect(audit.after).toMatchObject({ lotId: qr.id, mergedInto: byNumber.id, quantity: 3 });
  });

  it("keeps the earlier position when the merged-away lot was the default", async () => {
    const { boxLine } = await packing();
    const fake = lumexia();
    const found = fake.addLot({ itemId: ITEM, lotNumber: "BASE1234.A12A0124" });
    const qr = await lot(boxLine.id, { lotNumber: null, lumexiaLotId: found.id, quantity: 2 });
    const byNumber = await lot(boxLine.id, { quantity: 1, position: 1 });

    await validateLots(db, fake, [qr.id], { now: NOW });

    expect(await db.packageItemLot.findUnique({ where: { id: qr.id } })).toBeNull();
    expect(await reread(byNumber.id)).toMatchObject({ quantity: 3, position: 0, status: "VALID" });
  });

  it("marks a lot only on other items WRONG_ITEM with one note, however often it's checked", async () => {
    const { order, pkg, boxLine } = await packing();
    const fake = lumexia();
    fake.addLot({ itemId: OTHER, lotNumber: "BASE1234.A12A0124" });
    const row = await lot(boxLine.id);

    await validateLots(db, fake, [row.id], { now: NOW });
    await validateLots(db, fake, [row.id], { now: NOW });

    expect(await reread(row.id)).toMatchObject({ status: "WRONG_ITEM", checkedAt: NOW });
    const written = await notes();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ orderId: order.id, packageId: pkg.id, authorId: null });
    expect(written[0]?.content).toContain("BASE1234.A12A0124");
    expect(written[0]?.content).toContain("OTHER999");
    expect(written[0]?.content).toContain("Widget");
  });

  it("still flags a wrong lot after the order left QA, and undoes nothing", async () => {
    const { order, boxLine } = await packing();
    await db.order.update({ where: { id: order.id }, data: { status: "READY" } });
    const fake = lumexia();
    fake.addLot({ itemId: OTHER, lotNumber: "BASE1234.A12A0124" });
    const row = await lot(boxLine.id);

    await validateLots(db, fake, [row.id], { now: NOW });

    expect(await reread(row.id)).toMatchObject({ status: "WRONG_ITEM", quantity: 3 });
    expect(await notes()).toHaveLength(1);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("READY");
  });

  it("marks a lot Lumexia doesn't know NOT_FOUND", async () => {
    const { boxLine } = await packing();
    const fake = lumexia();
    const qr = await lot(boxLine.id, {
      lotNumber: null,
      lumexiaLotId: crypto.randomUUID(),
    });
    const number = await lot(boxLine.id, { lotNumber: "BASE1234.Z99Z9999", position: 1 });

    const result = await validateLots(db, fake, [qr.id, number.id], { now: NOW });

    expect(result).toMatchObject({ notFound: 2 });
    expect(await reread(qr.id)).toMatchObject({ status: "NOT_FOUND", checkedAt: NOW });
    expect(await reread(number.id)).toMatchObject({ status: "NOT_FOUND", checkedAt: NOW });
  });

  it("skips lots already settled or gone", async () => {
    const { boxLine } = await packing();
    const fake = lumexia();
    const valid = await lot(boxLine.id, { status: "VALID", checkedAt: days(1) });

    const result = await validateLots(db, fake, [valid.id, crypto.randomUUID()], { now: NOW });

    expect(result).toMatchObject({ valid: 0, notFound: 0, wrongItem: 0, skipped: 2 });
    expect(fake.calls).toEqual([]);
    expect(await reread(valid.id)).toMatchObject({ checkedAt: days(1) });
  });

  it("leaves the lot UNVERIFIED when Lumexia is down, and throws for a retry", async () => {
    const { boxLine } = await packing();
    const fake = lumexia();
    fake.setDown(true);
    const row = await lot(boxLine.id);

    await expect(validateLots(db, fake, [row.id], { now: NOW })).rejects.toBeInstanceOf(
      LumexiaUnavailable,
    );

    expect(await reread(row.id)).toMatchObject({ status: "UNVERIFIED", checkedAt: null });
  });
  it("shows each lot's check in the order detail", async () => {
    const { packer, order, boxLine } = await packing();
    const fake = lumexia();
    fake.addLot({ itemId: ITEM, lotNumber: "BASE1234.A12A0124" });
    const row = await lot(boxLine.id);
    await validateLots(db, fake, [row.id], { now: NOW });

    const view = await getOrder(db, packer, { id: order.id });

    expect(view.packages[0]?.items[0]?.lots).toEqual([
      expect.objectContaining({ id: row.id, quantity: 3, status: "VALID", isDefault: true }),
    ]);
  });
});

describe("the lumexia.validateLots job", () => {
  it("retries 5 times, exponentially from 30 s", async () => {
    await db.$transaction((tx) =>
      enqueue(tx, queues.lumexiaValidateLots, { packageItemLotIds: [] }),
    );
    expect(await validateJobs()).toEqual([
      expect.objectContaining({ retry_limit: 4, retry_delay: 30 }),
    ]);
  });

  it("is enqueued with the scan, and not when the scan rolls back", async () => {
    const { packer, pkg, boxLine } = await packing();
    const none = async () => null;

    await scanLot(
      db,
      packer,
      { packageId: pkg.id, code: "BASE1234.A12A0124", scanId: "s1" },
      {
        connect: none,
      },
    );
    const saved = await db.packageItemLot.findFirstOrThrow({
      where: { packageItemId: boxLine.id },
    });
    expect((await validateJobs()).map((j) => j.ids)).toEqual([[saved.id]]);

    // Every unit has a lot already in a one-unit line: the scan is refused and rolls back.
    await db.packageItemLot.update({ where: { id: saved.id }, data: { quantity: 1 } });
    await db.packageItem.update({ where: { id: boxLine.id }, data: { quantity: 1 } });
    await expect(
      scanLot(
        db,
        packer,
        { packageId: pkg.id, code: "BASE1234.B07C1124", scanId: "s2" },
        {
          connect: none,
        },
      ),
    ).rejects.toMatchObject({ messageKey: "errors.lumexia.allUnitsHaveLots" });
    expect(await validateJobs()).toHaveLength(1);
  });

  it("skips while Lumexia isn't configured", async () => {
    const { boxLine } = await packing();
    const row = await lot(boxLine.id);

    const result = await runValidateLotsJob(
      db,
      { packageItemLotIds: [row.id] },
      {
        connect: async () => null,
      },
    );

    expect(result).toEqual({ skipped: "unconfigured" });
    expect(await reread(row.id)).toMatchObject({ status: "UNVERIFIED" });
  });

  it("ends a job's retries when Lumexia refuses the key", async () => {
    const { boxLine } = await packing();
    const row = await lot(boxLine.id);
    const fake = lumexia();
    fake.failNext(401);
    const jobId = await db.$transaction((tx) =>
      enqueue(tx, queues.lumexiaValidateLots, { packageItemLotIds: [row.id] }),
    );

    await expect(
      runValidateLotsJob(
        db,
        { packageItemLotIds: [row.id] },
        {
          connect: async () => fake,
          jobId: jobId as string,
        },
      ),
    ).rejects.toBeInstanceOf(LumexiaAuthError);

    const [job] = await validateJobs();
    expect(job?.retry_limit).toBe(0);
    expect(await reread(row.id)).toMatchObject({ status: "UNVERIFIED" });
  });

  it("keeps retrying while Lumexia is down", async () => {
    const { boxLine } = await packing();
    const row = await lot(boxLine.id);
    const fake = lumexia();
    fake.setDown(true);
    const jobId = await db.$transaction((tx) =>
      enqueue(tx, queues.lumexiaValidateLots, { packageItemLotIds: [row.id] }),
    );

    await expect(
      runValidateLotsJob(
        db,
        { packageItemLotIds: [row.id] },
        {
          connect: async () => fake,
          jobId: jobId as string,
        },
      ),
    ).rejects.toBeInstanceOf(LumexiaUnavailable);

    expect((await validateJobs())[0]?.retry_limit).toBe(4);
  });
});

describe("sweepLots", () => {
  it("re-queues unverified lots older than 5 minutes, and validates them once Lumexia is back", async () => {
    const { boxLine } = await packing();
    const old = await lot(boxLine.id, { scannedAt: minutes(6) });
    await lot(boxLine.id, { lotNumber: "BASE1234.B07C1124", position: 1, scannedAt: minutes(4) });

    expect(await sweepLots(db, NOW)).toEqual({ queued: 1 });
    const jobs = await validateJobs();
    expect(jobs.map((j) => j.ids)).toEqual([[old.id]]);

    const fake = lumexia();
    fake.addLot({ itemId: ITEM, lotNumber: "BASE1234.A12A0124" });
    await runValidateLotsJob(
      db,
      { packageItemLotIds: jobs[0]?.ids ?? [] },
      {
        connect: async () => fake,
        now: NOW,
      },
    );
    expect(await reread(old.id)).toMatchObject({ status: "VALID" });
  });

  it("re-checks NOT_FOUND lots once a day for 7 days, then leaves them", async () => {
    const { boxLine } = await packing();
    const due = await lot(boxLine.id, {
      status: "NOT_FOUND",
      scannedAt: days(3),
      checkedAt: days(1),
    });
    await lot(boxLine.id, {
      lotNumber: "BASE1234.B07C1124",
      position: 1,
      status: "NOT_FOUND",
      scannedAt: days(3),
      checkedAt: minutes(60),
    });
    await lot(boxLine.id, {
      lotNumber: "BASE1234.C01D0125",
      position: 2,
      status: "NOT_FOUND",
      scannedAt: days(8),
      checkedAt: days(2),
    });
    await lot(boxLine.id, {
      lotNumber: "BASE1234.D01D0125",
      position: 3,
      status: "VALID",
      scannedAt: days(3),
      checkedAt: days(2),
    });

    expect(await sweepLots(db, NOW)).toEqual({ queued: 1 });
    expect((await validateJobs()).map((j) => j.ids)).toEqual([[due.id]]);
  });

  it("a NOT_FOUND lot found later becomes VALID", async () => {
    const { boxLine } = await packing();
    const row = await lot(boxLine.id, {
      status: "NOT_FOUND",
      scannedAt: days(2),
      checkedAt: days(1),
    });
    const fake = lumexia();
    fake.addLot({ itemId: ITEM, lotNumber: "BASE1234.A12A0124" });

    await validateLots(db, fake, [row.id], { now: NOW });

    expect(await reread(row.id)).toMatchObject({ status: "VALID", checkedAt: NOW });
  });

  it("queues nothing when nothing is due", async () => {
    await packing();
    expect(await sweepLots(db, NOW)).toEqual({ queued: 0 });
    expect(await validateJobs()).toEqual([]);
  });
});
