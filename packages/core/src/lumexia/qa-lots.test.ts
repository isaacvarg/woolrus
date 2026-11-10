import type { Db, LotStatus } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import { demoRate, enableShipStation } from "../../test/qa-fixtures";
import { FakeLumexiaClient } from "../adapters/lumexia/fake";
import type { UserActor } from "../permissions";
import { completeQaWithLabels } from "../qa/complete";
import { getQaScreen } from "../qa/queries";
import { forceStatus } from "../workflow/service";
import { qaRemoveLot, qaReplaceLot } from "./lots";

// SPEC-lumexia "QA fixes" and the verified gate's lotWrongItem: success criteria 8 and 11.

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(async () => {
  await resetDb(db);
  await db.$executeRawUnsafe(
    `DELETE FROM pgboss.job WHERE name IN ('labels.purchase', 'lumexia.validateLots')`,
  );
});

const key = () => crypto.randomUUID();
const A = "BASE1234.A12A0124";
const C = "BASE1234.C01D0125";
const WRONG = "BASE9999.A12A0124";

/**
 * A verified QA order, claimed by a QA user, with one package holding 3 units of a line that
 * needs a lot (BASE1234): 2 × A (valid) and 1 × a lot whose status is `second`, by default a
 * lot of another item Lumexia flagged as `WRONG_ITEM`.
 */
async function qaOrder({ second = "WRONG_ITEM" as LotStatus } = {}) {
  await enableShipStation(db);
  const qa = await createActor(db, ["QA"]);
  const built = await createOrder(db, {
    status: "QA",
    claimedById: qa.userId,
    claimedAt: new Date(),
    lines: [{ quantity: 3, pickStatus: "PICKED", name: "Base 1G" }],
    packages: [{ items: [{ line: 0, quantity: 3, verified: true }] }],
  });
  await db.order.update({
    where: { id: built.order.id },
    data: {
      shipTo: {
        name: "Test Customer",
        address1: "1 Main St",
        city: "Austin",
        state: "TX",
        postalCode: "78701",
        country: "US",
      },
    },
  });
  const pkg = built.packages[0] as { id: string };
  await demoRate(db, pkg.id, { selected: true });
  await db.product.update({
    where: { id: built.items[0]?.productId as string },
    data: { lumexiaItemId: "item-BASE1234", lumexiaItemRef: "BASE1234", lotOverride: true },
  });
  const boxLine = await db.packageItem.findFirstOrThrow({ where: { packageId: pkg.id } });
  await db.packageItemLot.create({
    data: { packageItemId: boxLine.id, lotNumber: A, quantity: 2, position: 0, status: "VALID" },
  });
  const wrong = await db.packageItemLot.create({
    data: { packageItemId: boxLine.id, lotNumber: WRONG, quantity: 1, position: 1, status: second },
  });
  return { qa, ...built, pkg, boxLine, wrong };
}

const screen = (actor: UserActor, orderId: string) => getQaScreen(db, actor, { orderId });

/** "A12A0124:2 C01D0125:1", the box line's lots in position order. */
async function lotsOf(packageItemId: string) {
  const rows = await db.packageItemLot.findMany({
    where: { packageItemId },
    orderBy: { position: "asc" },
  });
  return rows.map((r) => `${r.lotNumber?.split(".")[1]}:${r.quantity}`).join(" ");
}

const wrongItemCondition = {
  messageKey: "errors.workflow.gate.lotWrongItem",
  params: { line: "Base 1G", package: 1, lotNumber: WRONG },
};

describe("QA sees lots and the lotWrongItem block", () => {
  it("shows each row's lots with their status, and blocks on a WRONG_ITEM lot", async () => {
    const { qa, order, boxLine } = await qaOrder();

    const view = await screen(qa, order.id);

    const row = view.packages[0]?.rows[0];
    expect(row?.id).toBe(boxLine.id);
    expect(row).toMatchObject({
      needsLot: true,
      lots: [
        { lotNumber: A, quantity: 2, status: "VALID", isDefault: true },
        { lotNumber: WRONG, quantity: 1, status: "WRONG_ITEM", isDefault: false },
      ],
    });
    expect(view.unmet).toEqual([wrongItemCondition]);
  });

  it.each(["NOT_FOUND", "UNVERIFIED", "VALID"] as const)("never blocks on a %s lot", async (s) => {
    const { qa, order } = await qaOrder({ second: s });
    expect((await screen(qa, order.id)).unmet).toEqual([]);
  });

  it("refuses Complete QA, so no label is bought for it", async () => {
    const { qa, order } = await qaOrder();

    await expect(
      completeQaWithLabels(db, qa, { orderId: order.id, expectedVersion: order.version }),
    ).rejects.toMatchObject({
      kind: "CONFLICT",
      messageKey: "errors.workflow.gateFailed",
      unmet: [wrongItemCondition],
    });
    expect(await db.shippingLabel.count()).toBe(0);
  });

  it("lets an admin force the order on anyway", async () => {
    const { order } = await qaOrder();
    const admin = await createActor(db, ["ADMIN"]);

    const forced = await forceStatus(db, admin, {
      orderId: order.id,
      expectedVersion: order.version,
      to: "READY",
      reason: "Lot checked by hand",
    });
    expect(forced.status).toBe("READY");
  });
});

describe("qaReplaceLot", () => {
  it("puts the new lot on the line with the old one's units, and clears the block", async () => {
    const { qa, order, boxLine, wrong } = await qaOrder();
    const scanId = key();

    const result = await qaReplaceLot(db, qa, { lotId: wrong.id, code: C.toLowerCase(), scanId });

    expect(await lotsOf(boxLine.id)).toBe("A12A0124:2 C01D0125:1");
    const added = await db.packageItemLot.findFirstOrThrow({ where: { lotNumber: C } });
    expect(added).toMatchObject({ status: "UNVERIFIED", position: 1, scannedById: qa.userId });
    expect(result.unmet).toEqual([]);
    expect(await db.packageItemLot.count({ where: { id: wrong.id } })).toBe(0);
    const audit = await db.auditEvent.findMany({ where: { action: "lot.qaReplace" } });
    expect(audit).toMatchObject([
      { entityType: "PackageItem", entityId: boxLine.id, actorId: qa.userId },
    ]);
    // The new lot is checked against Lumexia like any other.
    const jobs = await db.$queryRawUnsafe<{ data: { packageItemLotIds: string[] } }[]>(
      `SELECT data FROM pgboss.job WHERE name = 'lumexia.validateLots'`,
    );
    expect(jobs.map((j) => j.data.packageItemLotIds)).toEqual([[added.id]]);

    // A retry answers without replacing again.
    await qaReplaceLot(db, qa, { lotId: wrong.id, code: C, scanId });
    expect(await db.auditEvent.count({ where: { action: "lot.qaReplace" } })).toBe(1);
    expect((await screen(qa, order.id)).unmet).toEqual([]);
  });

  it("gives the units to a lot already on the line", async () => {
    const { qa, boxLine, wrong } = await qaOrder();

    await qaReplaceLot(db, qa, { lotId: wrong.id, code: A, scanId: key() });

    expect(await lotsOf(boxLine.id)).toBe("A12A0124:3");
  });

  it("takes a QR code Lumexia resolves to the line's item, with its number", async () => {
    const { qa, boxLine, wrong } = await qaOrder();
    const lumexia = new FakeLumexiaClient();
    const lot = lumexia.addLot({ itemId: "item-BASE1234", lotNumber: C });

    await qaReplaceLot(
      db,
      qa,
      { lotId: wrong.id, code: lot.id, scanId: key() },
      { connect: async () => lumexia },
    );

    expect(
      await db.packageItemLot.findFirst({ where: { packageItemId: boxLine.id, position: 1 } }),
    ).toMatchObject({ lotNumber: C, lumexiaLotId: lot.id });
  });

  it("refuses a lot for yet another item with one note, changing nothing", async () => {
    const { qa, order, pkg, boxLine, wrong } = await qaOrder();
    const scanId = key();
    const other = "OTHER7.B01B0125";

    for (let i = 0; i < 2; i++) {
      await expect(
        qaReplaceLot(db, qa, { lotId: wrong.id, code: other, scanId }),
      ).rejects.toMatchObject({
        kind: "CONFLICT",
        messageKey: "errors.lumexia.lotWrongItem",
        params: { lotNumber: other, itemRef: "OTHER7" },
      });
    }

    expect(await lotsOf(boxLine.id)).toBe("A12A0124:2 A12A0124:1");
    expect(await db.auditEvent.count({ where: { action: "lot.qaReplace" } })).toBe(0);
    const notes = await db.note.findMany({ where: { orderId: order.id } });
    expect(notes).toMatchObject([
      {
        packageId: pkg.id,
        visibility: "INTERNAL",
        authorId: qa.userId,
        content:
          "Lot OTHER7.B01B0125 (item OTHER7) was scanned for Base 1G and rejected: it belongs to a different item.",
      },
    ]);
    expect((await screen(qa, order.id)).unmet).toEqual([wrongItemCondition]);
  });

  it("refuses what isn't a lot", async () => {
    const { qa, wrong } = await qaOrder();
    await expect(
      qaReplaceLot(db, qa, { lotId: wrong.id, code: "E2E-SKU", scanId: key() }),
    ).rejects.toMatchObject({ kind: "BAD_REQUEST", messageKey: "errors.lumexia.notALot" });
  });
});

describe("qaRemoveLot", () => {
  it("gives the lot's units to the default lot, and clears the block", async () => {
    const { qa, boxLine, wrong } = await qaOrder();

    const result = await qaRemoveLot(db, qa, { lotId: wrong.id });

    expect(await lotsOf(boxLine.id)).toBe("A12A0124:3");
    expect(result.unmet).toEqual([]);
    expect(result.packages[0]?.rows[0]?.lots).toMatchObject([{ lotNumber: A, quantity: 3 }]);
    expect(await db.auditEvent.count({ where: { action: "lot.qaRemove" } })).toBe(1);
  });
});

describe("QA lot fixes: who and when", () => {
  const fixes = [
    [
      "qaReplaceLot",
      (actor: UserActor, lotId: string) =>
        qaReplaceLot(db, actor, { lotId, code: C, scanId: key() }),
    ],
    ["qaRemoveLot", (actor: UserActor, lotId: string) => qaRemoveLot(db, actor, { lotId })],
  ] as const;

  it.each(fixes)("%s is forbidden without order.qa", async (_name, fix) => {
    const { wrong } = await qaOrder();
    for (const role of ["PACKER", "PICKER", "SHIPPER"] as const) {
      await expect(fix(await createActor(db, [role]), wrong.id)).rejects.toMatchObject({
        kind: "FORBIDDEN",
      });
    }
  });

  it.each(fixes)("%s needs the QA claim", async (_name, fix) => {
    const { boxLine, wrong } = await qaOrder();
    await expect(fix(await createActor(db, ["QA"]), wrong.id)).rejects.toMatchObject({
      messageKey: "errors.workflow.claimRequired",
    });
    expect(await lotsOf(boxLine.id)).toBe("A12A0124:2 A12A0124:1");
  });

  it.each(fixes)("%s needs the order in QA", async (_name, fix) => {
    const { qa, order, wrong } = await qaOrder();
    await db.order.update({ where: { id: order.id }, data: { status: "PACKING" } });
    await expect(fix(qa, wrong.id)).rejects.toMatchObject({ messageKey: "errors.qa.notQa" });
  });

  it.each(fixes)("%s is allowed for the claim holder", async (_name, fix) => {
    const { qa, wrong } = await qaOrder();
    await expect(fix(qa, wrong.id)).resolves.toMatchObject({ unmet: [] });
  });
});
