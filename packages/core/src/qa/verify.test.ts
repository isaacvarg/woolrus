import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder, createRate } from "../../test/factories";
import { AppError } from "../errors";
import { getQaScreen } from "./queries";
import { setVerified } from "./verify";

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const key = () => crypto.randomUUID();

/** A QA order with one package of 3 jars and 1 lid, claimed by a fresh QA user. */
async function inQa(extra: { label?: "PURCHASING" | "ACTIVE" } = {}) {
  const qa = await createActor(db, ["QA"]);
  const built = await createOrder(db, {
    status: "QA",
    claimedById: qa.userId,
    lines: [
      { quantity: 3, pickStatus: "PICKED" },
      { quantity: 1, pickStatus: "PICKED" },
    ],
    packages: [
      {
        items: [
          { line: 0, quantity: 3 },
          { line: 1, quantity: 1 },
        ],
        ...(extra.label ? { label: extra.label } : {}),
      },
    ],
  });
  const rows = await db.packageItem.findMany({
    where: { packageId: built.packages[0]?.id },
    orderBy: { quantity: "desc" },
  });
  return { qa, ...built, rows };
}

const row = (id: string) => db.packageItem.findUniqueOrThrow({ where: { id } });
const audits = () => db.auditEvent.count({ where: { action: { startsWith: "packageItem." } } });

describe("setVerified", () => {
  it("verifies a row in full, then clears it", async () => {
    const { qa, rows } = await inQa();
    const jars = rows[0];
    if (!jars) throw new Error("no row");

    await setVerified(db, qa, { packageItemId: jars.id, verified: true, idempotencyKey: key() });
    expect(await row(jars.id)).toMatchObject({
      qaVerifiedQuantity: 3,
      qaVerifiedById: qa.userId,
    });
    expect((await row(jars.id)).qaVerifiedAt).not.toBeNull();

    await setVerified(db, qa, { packageItemId: jars.id, verified: false, idempotencyKey: key() });
    expect(await row(jars.id)).toMatchObject({
      qaVerifiedQuantity: 0,
      qaVerifiedAt: null,
      qaVerifiedById: null,
    });
  });

  it("clears a partly verified row and audits both moves", async () => {
    const { qa, rows } = await inQa();
    const jars = rows[0];
    if (!jars) throw new Error("no row");
    await db.packageItem.update({ where: { id: jars.id }, data: { qaVerifiedQuantity: 2 } });

    await setVerified(db, qa, { packageItemId: jars.id, verified: true, idempotencyKey: key() });
    await setVerified(db, qa, { packageItemId: jars.id, verified: false, idempotencyKey: key() });
    const actions = await db.auditEvent.findMany({
      where: { entityId: jars.id },
      orderBy: { at: "asc" },
    });
    expect(actions.map((a) => a.action)).toEqual(["packageItem.verify", "packageItem.unverify"]);
  });

  it("is idempotent: the same state again, or a replayed key, writes nothing more", async () => {
    const { qa, rows } = await inQa();
    const jars = rows[0];
    if (!jars) throw new Error("no row");
    const k = key();
    await setVerified(db, qa, { packageItemId: jars.id, verified: true, idempotencyKey: k });
    await setVerified(db, qa, { packageItemId: jars.id, verified: true, idempotencyKey: k });
    await setVerified(db, qa, { packageItemId: jars.id, verified: true, idempotencyKey: key() });
    expect(await audits()).toBe(1);
  });

  it("refuses outside QA, without the claim and while a label is purchasing, changing nothing", async () => {
    const { qa, rows, order } = await inQa();
    const jars = rows[0];
    if (!jars) throw new Error("no row");
    const attempt = () =>
      setVerified(db, qa, { packageItemId: jars.id, verified: true, idempotencyKey: key() });

    const other = await createActor(db, ["QA"]);
    await expect(
      setVerified(db, other, { packageItemId: jars.id, verified: true, idempotencyKey: key() }),
    ).rejects.toMatchObject({ messageKey: "errors.workflow.claimRequired" });

    await db.order.update({ where: { id: order.id }, data: { claimedAt: new Date(0) } });
    await expect(attempt()).rejects.toMatchObject({ messageKey: "errors.workflow.claimRequired" });
    await db.order.update({ where: { id: order.id }, data: { claimedAt: new Date() } });

    await db.shippingLabel.create({
      data: {
        packageId: jars.packageId,
        status: "PURCHASING",
        provider: "SHIPSTATION",
        idempotencyKey: key(),
        carrierCode: "usps",
        serviceCode: "usps_ground_advantage",
        currency: "USD",
      },
    });
    await expect(attempt()).rejects.toMatchObject({
      messageKey: "errors.qa.purchaseInProgress",
    });
    await db.shippingLabel.deleteMany({});

    await db.order.update({ where: { id: order.id }, data: { status: "PACKING" } });
    await expect(attempt()).rejects.toMatchObject({ messageKey: "errors.qa.notQa" });

    expect((await row(jars.id)).qaVerifiedQuantity).toBe(0);
    expect(await audits()).toBe(0);
  });

  it("is forbidden for a packer and unknown ids are not found", async () => {
    const { rows } = await inQa();
    const packer = await createActor(db, ["PACKER"]);
    await expect(
      setVerified(db, packer, {
        packageItemId: rows[0]?.id as string,
        verified: true,
        idempotencyKey: key(),
      }),
    ).rejects.toBeInstanceOf(AppError);
    const qa = await createActor(db, ["QA"]);
    await expect(
      setVerified(db, qa, {
        packageItemId: crypto.randomUUID(),
        verified: true,
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });
  });
});

describe("getQaScreen", () => {
  it("shows each package's rows with how many are verified, and the unmet conditions", async () => {
    const { qa, rows, order } = await inQa();
    const jars = rows[0];
    if (!jars) throw new Error("no row");
    await setVerified(db, qa, { packageItemId: jars.id, verified: true, idempotencyKey: key() });

    const screen = await getQaScreen(db, qa, { orderId: order.id });
    const pkg = screen.packages[0];
    expect(pkg?.rows.map((r) => [r.quantity, r.verifiedQuantity])).toEqual([
      [3, 3],
      [1, 0],
    ]);
    expect(pkg?.rows[0]?.verifiedBy).not.toBeNull();
    expect(screen.purchase).toEqual({ kind: "idle" });
    expect(screen.unmet.map((u) => u.messageKey)).toContain(
      "errors.workflow.gate.packageNotVerified",
    );
  });

  it("flags a row with an open critical issue, and carries picker and packer", async () => {
    const { qa, rows, order, items } = await inQa();
    await db.qualityIssue.create({
      data: {
        orderId: order.id,
        orderItemId: items[0]?.id,
        type: "DAMAGED_ITEM",
        severity: "CRITICAL",
        status: "OPEN",
        discoveredStage: "QA",
        reporterId: qa.userId,
        description: "crushed",
      },
    });
    const screen = await getQaScreen(db, qa, { orderId: order.id });
    const flagged = screen.packages[0]?.rows.map((r) => r.criticalIssueId !== null);
    expect(rows.length).toBe(2);
    expect(flagged).toEqual([true, false]);
  });

  it("reports a purchase in progress and anyone with order.read can read", async () => {
    const { rows, order } = await inQa({ label: "PURCHASING" });
    expect(rows).toHaveLength(2);
    const packer = await createActor(db, ["PACKER"]);
    const screen = await getQaScreen(db, packer, { orderId: order.id });
    expect(screen.purchase).toEqual({ kind: "purchasing", bought: 0, total: 1 });
    expect(screen.packages[0]?.label?.status).toBe("PURCHASING");
  });

  it("carries the selected rate and who picked and packed each row", async () => {
    const { qa, order, packages } = await inQa();
    await createRate(db, packages[0]?.id as string, { selected: true, amountCents: 725 });
    await db.packageItem.updateMany({ data: { packedById: qa.userId } });
    await db.orderItem.updateMany({
      where: { orderId: order.id },
      data: { pickedById: qa.userId },
    });

    const screen = await getQaScreen(db, qa, { orderId: order.id });
    expect(screen.packages[0]?.selectedRate).toMatchObject({ amountCents: 725 });
    const first = screen.packages[0]?.rows[0];
    expect(first?.pickedBy).toBeTruthy();
    expect(first?.packedBy).toBeTruthy();
  });

  it("is not found for an unknown order", async () => {
    const qa = await createActor(db, ["QA"]);
    await expect(getQaScreen(db, qa, { orderId: crypto.randomUUID() })).rejects.toMatchObject({
      kind: "NOT_FOUND",
    });
  });
});
