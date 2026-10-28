import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder, createRate } from "../../test/factories";
import { selectRate } from "./rates";

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

/** A QA order with two packages; package 1 has a selected $6.50 rate and a $9.00 one, claimed by a QA user. */
async function inQa(extra: { label?: "PURCHASING" | "ACTIVE"; status?: "PACKING" } = {}) {
  const qa = await createActor(db, ["QA"]);
  const built = await createOrder(db, {
    status: extra.status ?? "QA",
    claimedById: qa.userId,
    lines: [{ quantity: 2, pickStatus: "PICKED" }],
    packages: [
      {
        items: [{ line: 0, quantity: 1 }],
        ...(extra.label ? { label: extra.label } : {}),
      },
      { items: [{ line: 0, quantity: 1 }] },
    ],
  });
  const [p1, p2] = built.packages;
  if (!p1 || !p2) throw new Error("packages");
  const cheap = await createRate(db, p1.id, { selected: true, amountCents: 650 });
  const dear = await createRate(db, p1.id, { amountCents: 900 });
  const other = await createRate(db, p2.id, { selected: true });
  return { qa, ...built, p1, p2, cheap, dear, other };
}

const selected = (packageId: string) =>
  db.shippingRate.findMany({ where: { packageId, selected: true } });
const audits = () => db.auditEvent.count({ where: { action: "rate.select" } });

describe("selectRate", () => {
  it("moves the selection, leaves exactly one, and audits both rates", async () => {
    const { qa, p1, cheap, dear } = await inQa();

    const result = await selectRate(db, qa, { packageId: p1.id, rateId: dear.id });

    expect((await selected(p1.id)).map((r) => r.id)).toEqual([dear.id]);
    expect(result.packages[0]?.selectedRate).toMatchObject({ amountCents: 900 });
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: "rate.select" } });
    expect(audit).toMatchObject({ entityId: p1.id, actorId: qa.userId });
    expect(audit.before).toMatchObject({ rateId: cheap.id, amountCents: 650 });
    expect(audit.after).toMatchObject({ rateId: dear.id, amountCents: 900 });
  });

  it("selecting the selected rate changes and audits nothing", async () => {
    const { qa, p1, cheap } = await inQa();
    await selectRate(db, qa, { packageId: p1.id, rateId: cheap.id });
    expect((await selected(p1.id)).map((r) => r.id)).toEqual([cheap.id]);
    expect(await audits()).toBe(0);
  });

  it("refuses an expired rate", async () => {
    const { qa, p1, cheap, dear } = await inQa();
    await db.shippingRate.update({
      where: { id: dear.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(selectRate(db, qa, { packageId: p1.id, rateId: dear.id })).rejects.toMatchObject({
      kind: "CONFLICT",
      messageKey: "errors.qa.rateExpired",
    });
    expect((await selected(p1.id)).map((r) => r.id)).toEqual([cheap.id]);
    expect(await audits()).toBe(0);
  });

  it("refuses a rate of another package", async () => {
    const { qa, p1, p2, cheap, other } = await inQa();
    await expect(selectRate(db, qa, { packageId: p1.id, rateId: other.id })).rejects.toMatchObject({
      kind: "NOT_FOUND",
    });
    expect((await selected(p1.id)).map((r) => r.id)).toEqual([cheap.id]);
    expect((await selected(p2.id)).map((r) => r.id)).toEqual([other.id]);
    expect(await audits()).toBe(0);
  });

  it.each(["ACTIVE", "PURCHASING"] as const)("refuses a package with a %s label", async (label) => {
    const { qa, p1, cheap, dear } = await inQa({ label });
    await expect(selectRate(db, qa, { packageId: p1.id, rateId: dear.id })).rejects.toMatchObject({
      kind: "CONFLICT",
      messageKey: "errors.qa.packageHasLabel",
    });
    expect((await selected(p1.id)).map((r) => r.id)).toEqual([cheap.id]);
    expect(await audits()).toBe(0);
  });

  it("refuses outside QA and without the claim", async () => {
    const packing = await inQa({ status: "PACKING" });
    await expect(
      selectRate(db, packing.qa, { packageId: packing.p1.id, rateId: packing.dear.id }),
    ).rejects.toMatchObject({ messageKey: "errors.qa.notQa" });

    const { p1, dear } = await inQa();
    const stranger = await createActor(db, ["QA"]);
    await expect(
      selectRate(db, stranger, { packageId: p1.id, rateId: dear.id }),
    ).rejects.toMatchObject({
      messageKey: "errors.workflow.claimRequired",
    });
  });

  it("is allowed for QA and forbidden for a Packer", async () => {
    const { p1, dear } = await inQa();
    const packer = await createActor(db, ["PACKER"]);
    await expect(
      selectRate(db, packer, { packageId: p1.id, rateId: dear.id }),
    ).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
  });
});
