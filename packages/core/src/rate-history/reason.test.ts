import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder, createRate } from "../../test/factories";
import { fakeProvider, verifiedQaOrder } from "../../test/qa-fixtures";
import { createMemoryStorage } from "../adapters/storage/memory";
import { getOrderShipping } from "../carriers/rates";
import { completeQaWithLabels } from "../qa/complete";
import { purchaseLabels } from "../qa/purchase";
import { qaResult } from "../qa/queries";
import { selectRate, setRateSelectionReason } from "../qa/rates";

// SPEC-rate-history "Choice and purchase": an optional reason when QA picks a rate that isn't the
// cheapest purchasable one (criteria 8, 9 and 11).

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(async () => {
  await resetDb(db);
  await db.$executeRawUnsafe(`DELETE FROM pgboss.job WHERE name = 'labels.purchase'`);
});

/** A claimed QA order whose package has a selected $6.50 rate, a $9.00 one and a $12.00 one. */
async function inQa() {
  const qa = await createActor(db, ["QA"]);
  const built = await createOrder(db, {
    status: "QA",
    claimedById: qa.userId,
    lines: [{ quantity: 1, pickStatus: "PICKED" }],
    packages: [{ items: [{ line: 0, quantity: 1 }] }],
  });
  const pkg = built.packages[0];
  if (!pkg) throw new Error("package");
  const cheap = await createRate(db, pkg.id, { selected: true, amountCents: 650 });
  const dear = await createRate(db, pkg.id, { amountCents: 900 });
  const dearest = await createRate(db, pkg.id, { amountCents: 1200 });
  return { qa, ...built, pkg, cheap, dear, dearest };
}

const rateRow = (id: string) => db.shippingRate.findUniqueOrThrow({ where: { id } });

describe("selectRate with a reason (SC 8)", () => {
  it("stores the reason on a pricier rate, and audits it", async () => {
    const { qa, pkg, dear } = await inQa();

    await selectRate(db, qa, { packageId: pkg.id, rateId: dear.id, reason: "FASTER_DELIVERY" });

    expect(await rateRow(dear.id)).toMatchObject({
      selected: true,
      selectionReason: "FASTER_DELIVERY",
      selectionNote: null,
    });
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: "rate.select" } });
    expect(audit.after).toMatchObject({ rateId: dear.id, reason: "FASTER_DELIVERY" });
  });

  it("stores a note with Other", async () => {
    const { qa, pkg, dear } = await inQa();

    await selectRate(db, qa, {
      packageId: pkg.id,
      rateId: dear.id,
      reason: "OTHER",
      note: "Fragile, the customer asked for UPS",
    });

    expect(await rateRow(dear.id)).toMatchObject({
      selectionReason: "OTHER",
      selectionNote: "Fragile, the customer asked for UPS",
    });
  });

  it("refuses a reason on the cheapest rate", async () => {
    const { qa, pkg, cheap, dear } = await inQa();
    await selectRate(db, qa, { packageId: pkg.id, rateId: dear.id });

    await expect(
      selectRate(db, qa, { packageId: pkg.id, rateId: cheap.id, reason: "CUSTOMER_REQUESTED" }),
    ).rejects.toMatchObject({ kind: "CONFLICT", messageKey: "errors.qa.reasonNotNeeded" });
    expect(await rateRow(dear.id)).toMatchObject({ selected: true });
  });

  it("counts the cheapest among rates that can be bought", async () => {
    const { qa, pkg, cheap } = await inQa();
    await createRate(db, pkg.id, { provider: "BRIDGE_SOURCE", amountCents: 100 });
    await selectRate(db, qa, { packageId: pkg.id, rateId: cheap.id });

    await expect(
      setRateSelectionReason(db, qa, {
        packageId: pkg.id,
        rateId: cheap.id,
        reason: "FASTER_DELIVERY",
      }),
    ).rejects.toMatchObject({ messageKey: "errors.qa.reasonNotNeeded" });
  });

  it("refuses a note without Other", async () => {
    const { qa, pkg, dear } = await inQa();

    await expect(
      selectRate(db, qa, {
        packageId: pkg.id,
        rateId: dear.id,
        reason: "FASTER_DELIVERY",
        note: "why not",
      }),
    ).rejects.toMatchObject({ kind: "BAD_REQUEST", messageKey: "errors.qa.reasonNoteNeedsOther" });
    expect(await rateRow(dear.id)).toMatchObject({ selected: false });
  });

  it("selecting another rate clears the reason", async () => {
    const { qa, pkg, dear, dearest } = await inQa();
    await selectRate(db, qa, {
      packageId: pkg.id,
      rateId: dear.id,
      reason: "OTHER",
      note: "a note",
    });

    await selectRate(db, qa, { packageId: pkg.id, rateId: dearest.id });

    expect(await rateRow(dear.id)).toMatchObject({
      selected: false,
      selectionReason: null,
      selectionNote: null,
    });
    expect(await rateRow(dearest.id)).toMatchObject({ selected: true, selectionReason: null });
  });
});

describe("setRateSelectionReason (SC 8, 11)", () => {
  it("is allowed for QA: adds, changes and clears the selected rate's reason, audited", async () => {
    const { qa, pkg, dear } = await inQa();
    await selectRate(db, qa, { packageId: pkg.id, rateId: dear.id });

    await setRateSelectionReason(db, qa, {
      packageId: pkg.id,
      rateId: dear.id,
      reason: "CARRIER_RELIABILITY",
    });
    expect(await rateRow(dear.id)).toMatchObject({ selectionReason: "CARRIER_RELIABILITY" });

    const result = await setRateSelectionReason(db, qa, {
      packageId: pkg.id,
      rateId: dear.id,
      reason: "OTHER",
      note: "Hand-delivered last time",
    });
    expect(result.packages[0]?.selectedRate).toMatchObject({
      reason: "OTHER",
      note: "Hand-delivered last time",
    });

    await setRateSelectionReason(db, qa, { packageId: pkg.id, rateId: dear.id, reason: null });
    expect(await rateRow(dear.id)).toMatchObject({ selectionReason: null, selectionNote: null });

    const audits = await db.auditEvent.findMany({
      where: { action: "rate.reason", entityId: pkg.id },
      orderBy: { at: "asc" },
    });
    expect(audits.map((a) => (a.after as { reason: string | null }).reason)).toEqual([
      "CARRIER_RELIABILITY",
      "OTHER",
      null,
    ]);
    expect(audits[0]?.actorId).toBe(qa.userId);
  });

  it("is forbidden for a Packer", async () => {
    const { pkg, dear } = await inQa();
    const packer = await createActor(db, ["PACKER"]);

    await expect(
      setRateSelectionReason(db, packer, {
        packageId: pkg.id,
        rateId: dear.id,
        reason: "FASTER_DELIVERY",
      }),
    ).rejects.toMatchObject({ kind: "FORBIDDEN" });
  });

  it("refuses a note without Other, and a package whose label exists", async () => {
    const { qa, pkg, dear } = await inQa();
    await selectRate(db, qa, { packageId: pkg.id, rateId: dear.id });

    await expect(
      setRateSelectionReason(db, qa, {
        packageId: pkg.id,
        rateId: dear.id,
        reason: "FASTER_DELIVERY",
        note: "x",
      }),
    ).rejects.toMatchObject({ messageKey: "errors.qa.reasonNoteNeedsOther" });

    await db.shippingLabel.create({
      data: {
        packageId: pkg.id,
        status: "ACTIVE",
        provider: "SHIPSTATION",
        idempotencyKey: crypto.randomUUID(),
        carrierCode: "usps",
        serviceCode: "usps_ground_advantage",
        currency: "USD",
      },
    });
    await expect(
      setRateSelectionReason(db, qa, {
        packageId: pkg.id,
        rateId: dear.id,
        reason: "FASTER_DELIVERY",
      }),
    ).rejects.toMatchObject({ messageKey: "errors.qa.packageHasLabel" });
  });

  it("refuses a package with no selected rate", async () => {
    const { qa, pkg, cheap } = await inQa();
    await db.shippingRate.updateMany({ where: { packageId: pkg.id }, data: { selected: false } });

    await expect(
      setRateSelectionReason(db, qa, {
        packageId: pkg.id,
        rateId: cheap.id,
        reason: "FASTER_DELIVERY",
      }),
    ).rejects.toMatchObject({ kind: "CONFLICT", messageKey: "errors.qa.noRateSelected" });
  });
});

describe("reason edge cases", () => {
  const reasonAudits = () => db.auditEvent.count({ where: { action: "rate.reason" } });

  it("refuses a reason meant for a rate that's no longer selected", async () => {
    const { qa, pkg, dear, dearest } = await inQa();
    await selectRate(db, qa, { packageId: pkg.id, rateId: dear.id });
    await selectRate(db, qa, { packageId: pkg.id, rateId: dearest.id });

    await expect(
      setRateSelectionReason(db, qa, {
        packageId: pkg.id,
        rateId: dear.id,
        reason: "FASTER_DELIVERY",
      }),
    ).rejects.toMatchObject({ kind: "CONFLICT", messageKey: "errors.qa.rateNoLongerSelected" });
    expect(await rateRow(dearest.id)).toMatchObject({ selectionReason: null });
  });

  it("writes and audits nothing when the reason and note are what's stored", async () => {
    const { qa, pkg, dear } = await inQa();
    await selectRate(db, qa, { packageId: pkg.id, rateId: dear.id, reason: "OTHER", note: "n" });
    const set = () =>
      setRateSelectionReason(db, qa, {
        packageId: pkg.id,
        rateId: dear.id,
        reason: "OTHER",
        note: " n ",
      });

    await set();
    await selectRate(db, qa, { packageId: pkg.id, rateId: dear.id, reason: "OTHER", note: "n" });

    expect(await reasonAudits()).toBe(0);
    expect(await rateRow(dear.id)).toMatchObject({ selectionReason: "OTHER", selectionNote: "n" });
  });

  it("re-selecting the selected rate with a new reason saves it as rate.reason; without one keeps it", async () => {
    const { qa, pkg, dear } = await inQa();
    await selectRate(db, qa, { packageId: pkg.id, rateId: dear.id, reason: "FASTER_DELIVERY" });

    await selectRate(db, qa, { packageId: pkg.id, rateId: dear.id, reason: "CUSTOMER_REQUESTED" });
    expect(await rateRow(dear.id)).toMatchObject({ selectionReason: "CUSTOMER_REQUESTED" });
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: "rate.reason" } });
    expect(audit.before).toMatchObject({ rateId: dear.id, reason: "FASTER_DELIVERY" });
    expect(audit.after).toMatchObject({ rateId: dear.id, reason: "CUSTOMER_REQUESTED" });

    await selectRate(db, qa, { packageId: pkg.id, rateId: dear.id });
    expect(await rateRow(dear.id)).toMatchObject({ selectionReason: "CUSTOMER_REQUESTED" });
    expect(await reasonAudits()).toBe(1);
  });

  it("refuses a note that's blank or over 200 characters, even called directly", async () => {
    const { qa, pkg, dear } = await inQa();
    await selectRate(db, qa, { packageId: pkg.id, rateId: dear.id });

    for (const note of ["   ", "x".repeat(201)]) {
      await expect(
        setRateSelectionReason(db, qa, {
          packageId: pkg.id,
          rateId: dear.id,
          reason: "OTHER",
          note,
        }),
      ).rejects.toMatchObject({ kind: "BAD_REQUEST" });
    }
    await expect(
      setRateSelectionReason(db, qa, {
        packageId: pkg.id,
        rateId: dear.id,
        reason: null,
        note: "x",
      }),
    ).rejects.toMatchObject({ messageKey: "errors.qa.reasonNoteNeedsOther" });
  });

  it("refuses a QA user without the claim, and an order no longer in QA", async () => {
    const { qa, order, pkg, dear } = await inQa();
    await selectRate(db, qa, { packageId: pkg.id, rateId: dear.id });
    const stranger = await createActor(db, ["QA"]);
    const input = { packageId: pkg.id, rateId: dear.id, reason: "FASTER_DELIVERY" } as const;

    await expect(setRateSelectionReason(db, stranger, input)).rejects.toMatchObject({
      messageKey: "errors.workflow.claimRequired",
    });
    await db.order.update({ where: { id: order.id }, data: { status: "READY" } });
    await expect(setRateSelectionReason(db, qa, input)).rejects.toMatchObject({
      messageKey: "errors.qa.notQa",
    });
  });
});

describe("the reads", () => {
  it("the QA screen and the order's shipping mark the cheapest and show the reason", async () => {
    const { qa, order, pkg, cheap, dear } = await inQa();
    await selectRate(db, qa, { packageId: pkg.id, rateId: dear.id, reason: "FASTER_DELIVERY" });

    const screen = await db.$transaction((tx) => qaResult(tx, order.id));
    const qaPkg = screen.packages[0];
    expect(qaPkg?.rates.filter((r) => r.cheapest).map((r) => r.id)).toEqual([cheap.id]);
    expect(qaPkg?.selectedRate).toMatchObject({ reason: "FASTER_DELIVERY", note: null });

    const shipping = await getOrderShipping(db, qa, { orderId: order.id });
    const shippingPkg = shipping.packages[0];
    expect(shippingPkg?.rates.filter((r) => r.cheapest).map((r) => r.id)).toEqual([cheap.id]);
    expect(shippingPkg).toMatchObject({ selectionReason: "FASTER_DELIVERY", selectionNote: null });
  });
});

describe("purchase copies the reason (SC 9)", () => {
  it("a bought label carries the selected rate's reason and note", async () => {
    const built = await verifiedQaOrder(db, 1);
    const rate = built.rates[0];
    if (!rate) throw new Error("rate");
    await db.shippingRate.update({
      where: { id: rate.id },
      data: { selectionReason: "OTHER", selectionNote: "Customer called" },
    });
    await completeQaWithLabels(db, built.qa, {
      orderId: built.order.id,
      expectedVersion: built.order.version,
    });

    await purchaseLabels(
      db,
      { providers: [fakeProvider()], storage: createMemoryStorage() },
      { orderId: built.order.id, requestedById: built.qa.userId },
    );

    expect(await db.shippingLabel.findFirstOrThrow()).toMatchObject({
      status: "ACTIVE",
      selectionReason: "OTHER",
      selectionNote: "Customer called",
    });
  });
});
