import { QueueStage } from "@woolrus/contracts";
import type { Db } from "@woolrus/db";
import { seedDemoOrders } from "@woolrus/db/demo";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { fullActivity } from "../../test/activity";
import { createActor, resetDb, testDb } from "../../test/db";
import type { Actor } from "../permissions";
import { getBatchSuggestions } from "../picking/queries";
import { evaluateGate, loadGateSnapshot } from "./gates";
import { recomputePriorities } from "./priority-rules";
import { getOrder, listQueue, queueCounts } from "./queries";

// The dev seed (T12) has to describe orders the workflow accepts, or the demo stack lies.

const db: Db = testDb();
afterAll(() => db.$disconnect());

let admin: Actor;
beforeEach(async () => {
  await resetDb(db);
  admin = await createActor(db, ["ADMIN"]);
});

describe("seedDemoOrders", () => {
  it("adds about 30 orders across every status, and re-running adds nothing", async () => {
    expect(await seedDemoOrders(db)).toBeGreaterThanOrEqual(25);

    const counts = await queueCounts(db, admin);
    for (const stage of QueueStage.options) {
      expect(counts[stage], stage).toBeGreaterThan(0);
    }
    expect(await db.order.count({ where: { status: "COMPLETED" } })).toBeGreaterThan(0);
    expect(await db.order.count({ where: { status: "CANCELLED" } })).toBeGreaterThan(0);

    const before = {
      orders: await db.order.count(),
      items: await db.orderItem.count(),
      products: await db.product.count(),
      events: await db.orderStageEvent.count(),
    };
    expect(await seedDemoOrders(db)).toBe(0);
    expect({
      orders: await db.order.count(),
      items: await db.orderItem.count(),
      products: await db.product.count(),
      events: await db.orderStageEvent.count(),
    }).toEqual(before);
  });

  it("gives products dimensions, all but one, and a Packing order whose line of 6 needs two boxes", async () => {
    await seedDemoOrders(db);

    const physical = await db.product.findMany({ where: { physical: true } });
    expect(physical.filter((p) => p.lengthIn === null)).toHaveLength(1);
    // One unweighed product, so a suggested batch can read "weight incomplete" (SPEC-picking A1).
    expect(physical.filter((p) => p.weightOz === null)).toHaveLength(1);
    const packing = await db.order.findMany({
      where: { status: "PACKING", packages: { none: {} } },
      include: { items: true },
    });
    expect(packing.some((o) => o.items.some((i) => i.quantity === 6))).toBe(true);
  });

  it("gives some products barcodes to scan", async () => {
    await seedDemoOrders(db);

    expect(await db.product.count({ where: { barcode: { not: null } } })).toBeGreaterThan(2);
  });

  it("seeds Pending orders that share products, so the queue suggests a batch (SPEC-picking A1)", async () => {
    await seedDemoOrders(db);
    const picker = await createActor(db, ["PICKER"]);

    const { suggestions } = await getBatchSuggestions(db, picker);

    const shared = suggestions.flatMap((s) => s.shared);
    expect(shared).toContainEqual(expect.objectContaining({ name: "Merino yarn, Red", orders: 5 }));
    expect(suggestions.some((s) => s.orders.length >= 3)).toBe(true);
    expect(suggestions.some((s) => s.missingWeightCount > 0)).toBe(true);
  });

  it("seeds enough pails that the default 200 lb limit cuts a card short (SPEC-picking A1)", async () => {
    await seedDemoOrders(db);
    const picker = await createActor(db, ["PICKER"]);
    const pails = await db.order.count({
      where: { status: "PENDING", items: { some: { sku: "WAX-PAIL-5" } } },
    });

    const { suggestions } = await getBatchSuggestions(db, picker);

    const card = suggestions.find((s) => s.shared.some((p) => p.name === "Beeswax pail 5 gal"));
    // The cart has slots left, but one more 720 oz pail would go over 3200 oz.
    expect(card?.orders.length).toBeLessThan(pails);
    expect(card?.weightOz).toBeLessThanOrEqual(3200);
    expect((card?.weightOz ?? 0) + 720).toBeGreaterThan(3200);
    expect(card?.shared).toContainEqual(expect.objectContaining({ name: "Pail lid", orders: 3 }));
  });

  it("puts a non-physical Rush Order line on an Urgent order, at the top of Pending", async () => {
    await seedDemoOrders(db);

    const [top] = (await listQueue(db, admin, { stage: "PENDING" })).rows;
    expect(top?.priority).toBe(2);
    const view = await getOrder(db, admin, { id: top?.id ?? "" });
    expect(view.lines.find((l) => l.name === "Rush Order")).toMatchObject({ physical: false });
  });

  it("includes an Express order, an old order and a held order with a reason", async () => {
    await seedDemoOrders(db);

    expect(
      await db.order.count({ where: { shippingMethod: { contains: "Express" }, priority: 1 } }),
    ).toBeGreaterThan(0);
    const twoDaysAgo = new Date(Date.now() - 48 * 3_600_000);
    expect(await db.order.count({ where: { orderedAt: { lt: twoDaysAgo } } })).toBeGreaterThan(0);
    const held = await db.order.findFirstOrThrow({ where: { status: "ON_HOLD" } });
    expect(held.holdReason).toBeTruthy();
    expect(held.heldFromStatus).not.toBeNull();
  });

  it("adds the priority rules that compute the priorities it seeded, once", async () => {
    const now = new Date();
    await seedDemoOrders(db, { now });

    const rules = await db.priorityRule.findMany({ orderBy: { position: "asc" } });
    expect(rules.map((r) => [r.name, r.priority, r.enabled])).toEqual([
      ["Rush Order", 2, true],
      ["Express shipping", 1, true],
      ["Waiting 2+ days", 1, true],
    ]);
    expect(await db.$transaction((tx) => recomputePriorities(tx, { now }))).toEqual({
      updated: 0,
    });

    await seedDemoOrders(db, { now });
    expect(await db.priorityRule.count()).toBe(rules.length);
  });

  it("gives every order a history ending in its current status", async () => {
    await seedDemoOrders(db);

    for (const order of await db.order.findMany()) {
      const { entries } = await fullActivity(db, admin, { id: order.id });
      const latest = entries.find((e) => e.action.startsWith("stage."));
      expect(latest?.params.to, order.number).toBe(order.status);
      expect(latest?.at.getTime(), order.number).toBe(order.statusChangedAt.getTime());
    }
  });

  it('gives the demo orders realistic activity (SPEC-order-activity "Dev data")', async () => {
    await seedDemoOrders(db);
    const feeds = await Promise.all(
      (await db.order.findMany()).map((o) => fullActivity(db, admin, { id: o.id })),
    );
    const items = feeds.flatMap((f) => f.entries.flatMap((e) => (e.count > 1 ? e.members : [e])));
    const actions = new Set(items.map((i) => i.action));
    for (const action of ["pick.pickLine", "package.add", "packageItem.verify", "issue.report"]) {
      expect(actions.has(action), action).toBe(true);
    }

    // A batch: a pick interval that began in one, shared by more than one order.
    const batched = feeds.flatMap((f) =>
      f.summary.stages.flatMap((s) => s.intervals.flatMap((i) => (i.batch ? [i.batch] : []))),
    );
    expect(batched.length).toBeGreaterThan(1);
    expect(batched[0]?.orders).toBeGreaterThan(1);

    // Packing with a reweigh: one box weighed twice.
    expect(
      feeds.some((f) => f.entries.filter((e) => e.action === "package.setWeight").length >= 2),
    ).toBe(true);
    // Two QA scan misses on one order, under Problems.
    expect(
      feeds.some(
        (f) =>
          f.entries.filter((e) => e.action.startsWith("scanMiss.") && e.category === "problems")
            .length === 2,
      ),
    ).toBe(true);
    expect(await db.scanMiss.count({ where: { stage: "QA" } })).toBe(2);
    // A repack: two Packing intervals.
    expect(
      feeds.some(
        (f) => (f.summary.stages.find((s) => s.stage === "PACKING")?.intervals.length ?? 0) === 2,
      ),
    ).toBe(true);
    // People worked the stages, so the summary has someone to show.
    expect(feeds.some((f) => f.people.some((p) => p.people.length > 0))).toBe(true);
  });

  it("leaves some orders in each stage ready to complete and some not, so gates can be demoed", async () => {
    await seedDemoOrders(db);

    const gateFor = { PICKING: "picked", PACKING: "packed", QA: "verified", READY: "shippable" };
    for (const [status, gate] of Object.entries(gateFor) as [keyof typeof gateFor, never][]) {
      const results = await Promise.all(
        (await db.order.findMany({ where: { status } })).map(async (o) =>
          evaluateGate(gate, await loadGateSnapshot(db, o.id)),
        ),
      );
      expect(
        results.some((unmet) => unmet.length === 0),
        `${status} has a ready order`,
      ).toBe(true);
      if (status !== "READY") {
        expect(
          results.some((unmet) => unmet.length > 0),
          `${status} has a blocked order`,
        ).toBe(true);
      }
    }
  });

  it("subtracts a void from a line's active quantity", async () => {
    await seedDemoOrders(db);
    const voided = await db.itemVoid.findFirstOrThrow();

    const view = await getOrder(db, admin, { id: voided.orderId });
    const line = view.lines.find((l) => l.id === voided.orderItemId);
    expect(line && line.quantity - line.activeQuantity).toBe(voided.quantity);
  });

  it("seeds the exceptions dev data: voids and issues in each state", async () => {
    await seedDemoOrders(db);

    const voids = await db.itemVoid.findMany({ include: { orderItem: true } });
    // A partial void (1 of 3), a fully voided order, and a resolved void.
    expect(voids.some((v) => !v.resolvedAt && v.quantity === 1 && v.orderItem.quantity === 3)).toBe(
      true,
    );
    expect(voids.some((v) => v.resolvedAt && v.resolution)).toBe(true);
    const fully = await db.order.findFirstOrThrow({ where: { customerName: "Gonzalo Pardo" } });
    expect(await getOrder(db, admin, { id: fully.id })).toMatchObject({ allVoided: true });

    const critical = await db.qualityIssue.findFirstOrThrow({
      where: { severity: "CRITICAL", status: "OPEN" },
      include: { notes: true },
    });
    expect(critical.notes).toHaveLength(1);
    const customer = await db.qualityIssue.findFirstOrThrow({
      where: { customerReported: true },
      include: { order: true },
    });
    expect(customer.order.status).toBe("COMPLETED");
    expect(await db.qualityIssue.count({ where: { status: "RESOLVED" } })).toBeGreaterThan(0);
  });
  it("adds the shipping dev data: a Ready order whose package 2 void is rejected, and two Canadian orders", async () => {
    await seedDemoOrders(db);

    const rejects = await db.order.findFirstOrThrow({
      where: { status: "READY", shippingAddress: { path: ["address2"], equals: "VOID-REJECT-2" } },
      include: { packages: { include: { labels: true } } },
    });
    expect(rejects.packages.map((p) => p.labels.length)).toEqual([1, 1]);
    expect((await evaluateGate("shippable", await loadGateSnapshot(db, rejects.id))).length).toBe(
      0,
    );

    const canadian = await db.order.findMany({
      where: { status: "READY", shippingAddress: { path: ["country"], equals: "CA" } },
      include: { items: { include: { product: true } } },
    });
    expect(canadian).toHaveLength(2);
    const complete = (o: (typeof canadian)[number]) =>
      o.items.every((i) => i.product?.hsCode && i.product.countryOfOrigin);
    expect(canadian.filter(complete)).toHaveLength(1);

    expect((await db.settings.findFirst())?.wooTrackingEnabled ?? false).toBe(false);
  });
});
