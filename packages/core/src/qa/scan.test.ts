import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import { AppError } from "../errors";
import { scanVerify } from "./scan";

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const key = () => crypto.randomUUID();

/** A QA order: package 1 holds 2 jars and a lid, package 2 holds a candle. */
async function inQa() {
  const qa = await createActor(db, ["QA"]);
  const built = await createOrder(db, {
    status: "QA",
    claimedById: qa.userId,
    lines: [
      { quantity: 2, pickStatus: "PICKED", sku: "JAR-1", barcode: "111" },
      { quantity: 1, pickStatus: "PICKED", sku: "LID-1" },
      { quantity: 1, pickStatus: "PICKED", sku: "CANDLE-1" },
    ],
    packages: [
      {
        items: [
          { line: 0, quantity: 2 },
          { line: 1, quantity: 1 },
        ],
      },
      { items: [{ line: 2, quantity: 1 }] },
    ],
  });
  const [p1, p2] = built.packages;
  if (!p1 || !p2) throw new Error("no packages");
  const input = (code: string, pkg = p1.id, scanId = key()) => ({
    orderId: built.order.id,
    packageId: pkg,
    code,
    scanId,
  });
  return { qa, ...built, p1, p2, input };
}

const rowOf = (orderItemId: string) => db.packageItem.findFirstOrThrow({ where: { orderItemId } });
const audits = () => db.auditEvent.count({ where: { action: { startsWith: "packageItem." } } });

describe("scanVerify", () => {
  it("adds one unit to the matching row, by SKU or barcode, case-insensitively", async () => {
    const { qa, items, input } = await inQa();
    const jars = items[0];
    if (!jars) throw new Error("no line");

    await scanVerify(db, qa, input(" jar-1 "));
    expect(await rowOf(jars.id)).toMatchObject({ qaVerifiedQuantity: 1, qaVerifiedAt: null });
    expect(await audits()).toBe(1);

    await scanVerify(db, qa, input("111"));
    const done = await rowOf(jars.id);
    expect(done).toMatchObject({ qaVerifiedQuantity: 2, qaVerifiedById: qa.userId });
    expect(done.qaVerifiedAt).not.toBeNull();
  });

  it("counts a replayed scanId once", async () => {
    const { qa, items, input } = await inQa();
    const scan = input("JAR-1");
    await scanVerify(db, qa, scan);
    await scanVerify(db, qa, scan);
    expect((await rowOf(items[0]?.id as string)).qaVerifiedQuantity).toBe(1);
    expect(await audits()).toBe(1);
  });

  it("refuses a code that is not on the order, changing nothing", async () => {
    const { qa, input } = await inQa();
    await expect(scanVerify(db, qa, input("NOPE"))).rejects.toBeInstanceOf(AppError);
    expect(await audits()).toBe(0);
    expect(await db.packageItem.count({ where: { qaVerifiedQuantity: { gt: 0 } } })).toBe(0);
  });

  it("names the package when the code is in another one", async () => {
    const { qa, input } = await inQa();
    await expect(scanVerify(db, qa, input("CANDLE-1"))).rejects.toMatchObject({
      messageKey: "errors.qa.scanOtherPackage",
      params: { package: 2 },
    });
    expect(await audits()).toBe(0);
  });

  it("refuses a row that is already fully verified", async () => {
    const { qa, items, input } = await inQa();
    await scanVerify(db, qa, input("LID-1"));
    await expect(scanVerify(db, qa, input("LID-1"))).rejects.toMatchObject({
      messageKey: "errors.qa.scanAlreadyVerified",
    });
    expect((await rowOf(items[1]?.id as string)).qaVerifiedQuantity).toBe(1);
    expect(await audits()).toBe(1);
  });

  it("offers the link only to someone who can manage products", async () => {
    const { qa, input } = await inQa();
    await expect(scanVerify(db, qa, input("NOPE"))).rejects.toMatchObject({ canLink: undefined });
    const admin = await createActor(db, ["ADMIN"]);
    await db.order.updateMany({ data: { claimedById: admin.userId } });
    await expect(scanVerify(db, admin, input("NOPE"))).rejects.toMatchObject({ canLink: true });
  });

  it("needs the claim and the QA stage, and refuses a package of another order", async () => {
    const { input, order } = await inQa();
    const other = await createActor(db, ["QA"]);
    await expect(scanVerify(db, other, input("JAR-1"))).rejects.toMatchObject({
      messageKey: "errors.workflow.claimRequired",
    });
    const second = await inQa();
    await expect(
      scanVerify(db, second.qa, { ...second.input("JAR-1"), orderId: order.id }),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });
    await db.order.update({ where: { id: order.id }, data: { status: "READY" } });
    await expect(scanVerify(db, other, input("JAR-1"))).rejects.toBeInstanceOf(AppError);
  });

  it("is forbidden for a packer", async () => {
    const { input } = await inQa();
    const packer = await createActor(db, ["PACKER"]);
    await expect(scanVerify(db, packer, input("JAR-1"))).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
  });
});
