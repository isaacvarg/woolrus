import type { ActivityParts } from "@woolrus/contracts";
import type { Db } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import type { UserActor } from "../permissions";
import { updateSettings } from "../settings/service";
import { claim } from "../workflow/claims";
import { beginPicking } from "../workflow/service";
import { getOrderActivity } from "./timeline";
import {
  activityPartsFor,
  parseActivityVisibility,
  seesActivity,
  visibleParts,
} from "./visibility";

const all: ActivityParts = { timeline: true, details: true, summary: true, people: true };

describe("visibleParts", () => {
  it("gives every role every part by default", () => {
    for (const role of ["PICKER", "PACKER", "QA", "SHIPPER", "RATE_LAB"] as const) {
      expect(visibleParts([role], {})).toEqual(all);
    }
  });

  it("takes a part away from a role switched off for it", () => {
    expect(visibleParts(["PACKER"], { PACKER: { people: false } })).toEqual({
      ...all,
      people: false,
    });
  });

  it("gives a person with several roles a part any of their roles has", () => {
    const setting = { PACKER: { people: false }, QA: { people: true, summary: false } };
    expect(visibleParts(["PACKER", "QA"], setting)).toEqual(all);
    expect(visibleParts(["QA"], setting)).toEqual({ ...all, summary: false });
  });

  it("always gives an Admin everything", () => {
    const off = { timeline: false, details: false, summary: false, people: false };
    const setting = { PICKER: off, PACKER: off, QA: off, SHIPPER: off, RATE_LAB: off };
    expect(visibleParts(["ADMIN"], setting)).toEqual(all);
    expect(visibleParts(["PACKER", "ADMIN"], setting)).toEqual(all);
    expect(visibleParts(["PACKER"], setting)).toEqual(off);
    expect(seesActivity(off)).toBe(false);
    expect(seesActivity({ ...off, people: true })).toBe(true);
  });

  it("gives someone with no roles nothing", () => {
    expect(seesActivity(visibleParts([], {}))).toBe(false);
  });

  it("gives no History tab for details alone, which only show inside the timeline", () => {
    const off = { timeline: false, details: false, summary: false, people: false };
    expect(seesActivity({ ...off, details: true })).toBe(false);
  });
});

describe("parseActivityVisibility", () => {
  it("keeps the valid switches when a stored role or part no longer exists", () => {
    const stored = {
      PACKER: { people: false, retired: false },
      GONE: { timeline: false },
      QA: { summary: "no" },
    };
    expect(parseActivityVisibility(stored)).toEqual({ PACKER: { people: false }, QA: {} });
    expect(visibleParts(["PACKER"], parseActivityVisibility(stored))).toEqual({
      ...all,
      people: false,
    });
  });

  it("reads anything that isn't an object as the default", () => {
    for (const stored of [null, "x", 3, []]) expect(parseActivityVisibility(stored)).toEqual({});
  });
});

const db: Db = testDb();
afterAll(() => db.$disconnect());

let admin: UserActor;
let picker: UserActor;
beforeEach(async () => {
  await resetDb(db);
  admin = await createActor(db, ["ADMIN"]);
  picker = await createActor(db, ["PICKER"]);
});

/** An order a picker has started, plus one row with before/after details. */
async function pickedOrder() {
  const { order } = await createOrder(db);
  await db.orderStageEvent.create({ data: { orderId: order.id, toStatus: "PENDING" } });
  await claim(db, picker, { orderId: order.id, expectedVersion: 1 });
  await beginPicking(db, picker, { orderId: order.id, expectedVersion: 2 });
  await db.auditEvent.create({
    data: {
      actorId: picker.userId,
      entityType: "Order",
      entityId: order.id,
      orderId: order.id,
      action: "order.setPriority",
      before: { priority: 0 },
      after: { priority: 1 },
    },
  });
  return order;
}

describe("orders.activity visibility", () => {
  it("sends every part to every role by default", async () => {
    const order = await pickedOrder();
    for (const roles of [["PICKER"], ["PACKER"], ["QA"], ["SHIPPER"], ["ADMIN"]] as const) {
      const feed = await getOrderActivity(db, await createActor(db, roles), { id: order.id });
      expect(feed.visible).toEqual(all);
      expect(feed.summary?.stages.length).toBeGreaterThan(0);
      expect(feed.people?.find((p) => p.stage === "PICKING")?.people).toHaveLength(1);
      expect(feed.entries?.some((e) => e.details !== null)).toBe(true);
    }
  });

  it("leaves people out for a packer with it off, not for someone also QA", async () => {
    const order = await pickedOrder();
    await updateSettings(db, admin, { activityVisibility: { PACKER: { people: false } } });

    const packer = await getOrderActivity(db, await createActor(db, ["PACKER"]), {
      id: order.id,
    });
    expect(packer.visible).toEqual({ ...all, people: false });
    expect(packer).not.toHaveProperty("people");
    expect(packer.summary).toBeDefined();
    expect(packer.entries?.length).toBeGreaterThan(0);

    const both = await getOrderActivity(db, await createActor(db, ["PACKER", "QA"]), {
      id: order.id,
    });
    expect(both.visible).toEqual(all);
    expect(both.people?.find((p) => p.stage === "PICKING")?.people).toHaveLength(1);
  });

  it("drops each hidden part from the response, and details from every entry", async () => {
    const order = await pickedOrder();
    await updateSettings(db, admin, {
      activityVisibility: {
        PICKER: { details: false },
        SHIPPER: { timeline: false, summary: false },
      },
    });

    const pickerFeed = await getOrderActivity(db, picker, { id: order.id });
    expect(pickerFeed.visible.details).toBe(false);
    const items = (pickerFeed.entries ?? []).flatMap((e) => [e, ...e.members]);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.details === null)).toBe(true);

    const shipper = await getOrderActivity(db, await createActor(db, ["SHIPPER"]), {
      id: order.id,
    });
    expect(Object.keys(shipper).sort()).toEqual(["people", "truncated", "visible"]);

    // Admins get everything whatever the setting says.
    const adminFeed = await getOrderActivity(db, admin, { id: order.id });
    expect(adminFeed.visible).toEqual(all);
    expect(adminFeed.entries?.some((e) => e.details !== null)).toBe(true);
  });

  it("tells the page when a viewer sees no part at all", async () => {
    const off = { timeline: false, details: false, summary: false, people: false };
    await updateSettings(db, admin, { activityVisibility: { PICKER: off } });
    expect(seesActivity(await activityPartsFor(db, picker))).toBe(false);
    expect(seesActivity(await activityPartsFor(db, admin))).toBe(true);
    const packer = await createActor(db, ["PACKER"]);
    expect(await activityPartsFor(db, packer)).toEqual(all);

    const order = await pickedOrder();
    const feed = await getOrderActivity(db, picker, { id: order.id });
    expect(feed).toEqual({ visible: off, truncated: false });
  });
});
