import type { Db } from "@woolrus/db";
import { messages } from "@woolrus/i18n";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import { recordPackApproval } from "../packing/approval";
import { acknowledgeCheck, confirmBox } from "../qa/pack-checks";
import { scanVerify } from "../qa/scan";
import { setVerified } from "../qa/verify";
import { actionMessageKey, actionRegistry } from "./actions";
import { getOrderActivity } from "./timeline";

// SPEC-order-activity #201: QA in the timeline.

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
const at = (min: number) => ({ now: minutesAgo(30 - min) });

describe("QA in the order's activity", () => {
  it("shows scans, verification, box confirmation, acknowledgements and approvals", async () => {
    const qa = await createActor(db, ["QA"]);
    await db.user.update({ where: { id: qa.userId }, data: { name: "Quinn" } });
    const manager = await createActor(db, ["QA"]);
    await db.user.update({ where: { id: manager.userId }, data: { name: "Marta" } });
    const { order, items, packages } = await createOrder(db, {
      status: "QA",
      claimedById: qa.userId,
      lines: [
        { name: "Jar 8 oz", quantity: 2, pickStatus: "PICKED", sku: "JAR-1" },
        { name: "Lid", quantity: 1, pickStatus: "PICKED", sku: "LID-1" },
      ],
      packages: [
        {
          items: [
            { line: 0, quantity: 2 },
            { line: 1, quantity: 1 },
          ],
        },
      ],
    });
    const [box] = packages;
    const lid = items[1];
    if (!box || !lid) throw new Error("no package");
    const approvalId = await db.$transaction((tx) =>
      recordPackApproval(tx, qa, {
        orderId: order.id,
        approval: { approverId: manager.userId, reason: "Box is fine", trips: [] },
        snapshot: {
          packages: [
            {
              number: 1,
              trips: [{ check: "NO_FIT", mode: "BLOCK", details: {} }],
            },
          ],
        } as never,
        now: at(0).now,
      }),
    );
    const trip = await db.packageCheckTrip.create({
      data: { packageId: box.id, check: "WEIGHT_OFF", mode: "WARN", details: {}, approvalId },
    });

    const scan = (code: string, min: number) =>
      scanVerify(
        db,
        qa,
        { orderId: order.id, packageId: box.id, code, scanId: crypto.randomUUID() },
        at(min),
      );
    await scan("JAR-1", 1);
    await scan("JAR-1", 2);
    const lidRow = await db.packageItem.findFirstOrThrow({ where: { orderItemId: lid.id } });
    const tap = (verified: boolean, min: number) =>
      setVerified(
        db,
        qa,
        { packageItemId: lidRow.id, verified, idempotencyKey: crypto.randomUUID() },
        at(min),
      );
    await tap(true, 3);
    await tap(false, 4);
    await confirmBox(db, qa, { packageId: box.id }, at(5));
    await acknowledgeCheck(db, qa, { tripId: trip.id }, at(6));

    // Every QA row carries its order.
    const rows = await db.auditEvent.findMany({ where: { orderId: order.id } });
    expect(rows.map((r) => r.action).sort()).toEqual([
      "approval.grant",
      "packCheckTrip.acknowledge",
      "package.confirmBox",
      "packageItem.scan",
      "packageItem.scan",
      "packageItem.unverify",
      "packageItem.verify",
    ]);

    const { entries } = await getOrderActivity(db, qa, { id: order.id });
    const byAction = (action: string) => entries.find((e) => e.action === action);

    expect(entries.every((e) => e.category === "qa")).toBe(true);
    expect(byAction("packageItem.scan")).toMatchObject({
      actor: { name: "Quinn" },
      target: { kind: "line", name: "Jar 8 oz" },
      params: { box: 1, verified: 2, quantity: 2 },
      count: 2,
    });
    expect(byAction("packageItem.verify")).toMatchObject({
      target: { kind: "line", name: "Lid" },
      params: { box: 1 },
    });
    expect(byAction("packageItem.unverify")).toMatchObject({
      target: { kind: "line", name: "Lid" },
      params: { box: 1 },
    });
    expect(byAction("package.confirmBox")).toMatchObject({ target: { kind: "box", number: 1 } });
    expect(byAction("packCheckTrip.acknowledge")).toMatchObject({
      target: { kind: "box", number: 1 },
      params: { check: "WEIGHT_OFF" },
    });
    expect(byAction("approval.grant")).toMatchObject({
      actor: { name: "Quinn" },
      params: { name: "Marta", kind: "PACKING_CHECKS", reason: "Box is fine" },
    });
  });

  it("words a QA lot replacement by its line", async () => {
    const qa = await createActor(db, ["QA"]);
    const { order, packages } = await createOrder(db, {
      lines: [{ name: "Serum", quantity: 1, pickStatus: "PICKED" }],
      packages: [{ items: [{ line: 0, quantity: 1 }] }],
    });
    const row = await db.packageItem.findFirstOrThrow({
      where: { packageId: packages[0]?.id },
    });
    await db.auditEvent.create({
      data: {
        actorId: qa.userId,
        entityType: "PackageItem",
        entityId: row.id,
        orderId: order.id,
        action: "lot.qaReplace",
        after: { lotNumber: "L-42", lots: [] },
      },
    });

    const { entries } = await getOrderActivity(db, qa, { id: order.id });
    expect(entries[0]).toMatchObject({
      category: "qa",
      target: { kind: "line", name: "Serum" },
      params: { lot: "L-42", box: 1 },
    });
  });
});

describe("QA wording", () => {
  const qaActions = Object.entries(actionRegistry)
    .filter(([, spec]) => spec.category === "qa")
    .map(([action]) => action);

  it.each(["en", "es"] as const)("words every QA action in %s", (locale) => {
    const words = messages[locale].activity.action as Record<string, string | undefined>;
    const missing = qaActions.filter(
      (action) => !words[actionMessageKey(action).slice("activity.action.".length)],
    );
    expect(missing).toEqual([]);
  });
});
