import type { Db, Role, WorkflowStatus } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import { csvStream } from "../csv";
import { AppError } from "../errors";
import { throughput, throughputCsv } from "./throughput";

// SPEC-reporting "Throughput" (criterion 1, and 7 for permissions): orders and units per day ×
// stage × person, on seeded events and items. America/Chicago is UTC-6 in November, so 05:30Z is
// 23:30 the local day before.

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const timeZone = "America/Chicago";
const range = { from: "2026-11-02", to: "2026-11-03", timeZone };
const at = (iso: string) => new Date(iso);

async function user(name: string) {
  return db.user.create({ data: { name, email: `${crypto.randomUUID()}@example.test` } });
}

async function event(
  orderId: string,
  from: WorkflowStatus | null,
  to: WorkflowStatus,
  when: string,
  actorId: string | null = null,
) {
  await db.orderStageEvent.create({
    data: { orderId, fromStatus: from, toStatus: to, at: at(when), actorId },
  });
}

async function audit(
  actorId: string,
  entityType: "Package" | "PackageItem",
  entityId: string,
  action: string,
  before: object,
  after: object,
  when: string,
) {
  await db.auditEvent.create({
    data: { actorId, entityType, entityId, action, before, after, at: at(when) },
  });
}

/**
 * Order 1001 goes the whole way on Nov 2, with a repack and a voided unit, and ships at 23:30 local
 * by the system. Order 1002 is imported on Nov 3 and picked at 23:30 local that day. One more pick
 * lands at 00:30 local on Nov 4, outside the range.
 */
async function seed() {
  const [picker, packerA, packerB, qa] = await Promise.all(
    ["Pat Picker", "Ana Packer", "Ben Packer", "Quinn QA"].map(user),
  );
  if (!picker || !packerA || !packerB || !qa) throw new Error("seed users");

  const shipped = await createOrder(db, {
    number: "1001",
    status: "COMPLETED",
    lines: [{ quantity: 3, pickStatus: "PICKED", pickedQuantity: 3, voids: [{ quantity: 1 }] }],
    packages: [{ items: [{ line: 0, quantity: 2 }] }, { items: [{ line: 0, quantity: 2 }] }],
  });
  const id = shipped.order.id;
  const line = shipped.items[0];
  const [first, second] = shipped.packages;
  if (!line || !first || !second) throw new Error("seed order");
  await db.orderItem.update({
    where: { id: line.id },
    data: { pickedById: picker.id, pickedAt: at("2026-11-02T15:00:00Z") },
  });
  // Box work is read from the audit trail, as the app writes it: the box lines keep only their
  // latest state. Pass 1: Ana packs 2 into the first box and Quinn scans both.
  const box = (units: number) => ({
    items: units ? [{ orderItemId: line.id, quantity: units }] : [],
  });
  const verified = (n: number) => ({ verifiedQuantity: n, quantity: 2 });
  await audit(
    packerA.id,
    "Package",
    first.id,
    "package.packUnits",
    box(0),
    box(2),
    "2026-11-02T17:00:00Z",
  );
  await audit(
    qa.id,
    "PackageItem",
    line.id,
    "packageItem.scan",
    verified(0),
    verified(1),
    "2026-11-02T17:20:00Z",
  );
  await audit(
    qa.id,
    "PackageItem",
    line.id,
    "packageItem.scan",
    verified(1),
    verified(2),
    "2026-11-02T17:21:00Z",
  );
  // The repack at 17:30 clears QA without an audit row of its own. Pass 2: Ben packs 1 into the
  // second box and Ana scans 1 more into the same line; the first box is thrown away (it keeps
  // counting for Ana). Quinn verifies the line, takes it back by mistake and verifies it again.
  await audit(
    packerB.id,
    "Package",
    second.id,
    "package.packUnits",
    box(0),
    box(1),
    "2026-11-02T18:00:00Z",
  );
  await audit(
    packerA.id,
    "Package",
    second.id,
    "package.scan",
    box(1),
    box(2),
    "2026-11-02T18:02:00Z",
  );
  await audit(
    packerB.id,
    "Package",
    first.id,
    "package.delete",
    box(2),
    box(0),
    "2026-11-02T18:30:00Z",
  );
  await db.package.update({
    where: { id: first.id },
    data: { discardedAt: at("2026-11-02T18:30Z") },
  });
  await audit(
    qa.id,
    "PackageItem",
    line.id,
    "packageItem.verify",
    verified(0),
    verified(2),
    "2026-11-02T18:50:00Z",
  );
  await audit(
    qa.id,
    "PackageItem",
    line.id,
    "packageItem.unverify",
    verified(2),
    verified(0),
    "2026-11-02T18:55:00Z",
  );
  await audit(
    qa.id,
    "PackageItem",
    line.id,
    "packageItem.verify",
    verified(0),
    verified(2),
    "2026-11-02T19:00:00Z",
  );
  await event(id, null, "PENDING", "2026-11-02T14:00:00Z");
  await event(id, "PENDING", "PICKING", "2026-11-02T14:30:00Z", picker.id);
  await event(id, "PICKING", "PACKING", "2026-11-02T16:00:00Z", picker.id);
  await event(id, "PACKING", "QA", "2026-11-02T17:05:00Z", packerA.id);
  await event(id, "QA", "PACKING", "2026-11-02T17:30:00Z", qa.id);
  await event(id, "PACKING", "QA", "2026-11-02T18:05:00Z", packerB.id);
  await event(id, "QA", "READY", "2026-11-02T19:05:00Z", qa.id);
  await event(id, "READY", "COMPLETED", "2026-11-03T05:30:00Z");

  const late = await createOrder(db, {
    number: "1002",
    status: "PACKING",
    lines: [{ quantity: 1, pickStatus: "PICKED" }],
  });
  await db.orderItem.updateMany({
    where: { orderId: late.order.id },
    data: { pickedById: picker.id, pickedAt: at("2026-11-04T05:30:00Z") },
  });
  await event(late.order.id, null, "PENDING", "2026-11-03T15:00:00Z");
  await event(late.order.id, "PICKING", "PACKING", "2026-11-04T05:30:00Z", picker.id);

  const outside = await createOrder(db, {
    number: "1003",
    status: "PACKING",
    lines: [{ quantity: 5, pickStatus: "PICKED" }],
  });
  await db.orderItem.updateMany({
    where: { orderId: outside.order.id },
    data: { pickedById: picker.id, pickedAt: at("2026-11-04T06:30:00Z") },
  });
  await event(outside.order.id, "PICKING", "PACKING", "2026-11-04T06:30:00Z", picker.id);

  const person = (u: { id: string; name: string }) => ({ id: u.id, name: u.name });
  return {
    picker: person(picker),
    packerA: person(packerA),
    packerB: person(packerB),
    qa: person(qa),
    system: { id: null, name: null },
  };
}

describe("throughput", () => {
  it("counts orders and units per day × stage × person, exactly", async () => {
    const p = await seed();
    const admin = await createActor(db, ["ADMIN"]);

    const report = await throughput(db, admin, range);

    expect(report.days).toEqual([
      { day: "2026-11-02", imported: 1, shipped: 1 },
      { day: "2026-11-03", imported: 1, shipped: 0 },
    ]);
    expect(report.rows).toEqual([
      // 3 picked, 1 voided.
      { day: "2026-11-02", stage: "PICKING", person: p.picker, orders: 1, units: 2 },
      // Both passes count: Ana keeps the discarded box and her unit on Ben's line; Ben his own.
      { day: "2026-11-02", stage: "PACKING", person: p.packerA, orders: 1, units: 3 },
      { day: "2026-11-02", stage: "PACKING", person: p.packerB, orders: 1, units: 1 },
      { day: "2026-11-02", stage: "QA", person: p.qa, orders: 1, units: 4 },
      // Shipped by the system at 23:30 local: Nov 2, under System, with the live package's units.
      { day: "2026-11-02", stage: "SHIPPING", person: p.system, orders: 1, units: 2 },
      // Picked at 23:30 local on Nov 3; the 00:30 Nov 4 pick is outside the range.
      { day: "2026-11-03", stage: "PICKING", person: p.picker, orders: 1, units: 1 },
    ]);
    expect(report.people).toEqual([
      { stage: "PICKING", person: p.picker, orders: 2, units: 3, activeDays: 2 },
      { stage: "PACKING", person: p.packerA, orders: 1, units: 3, activeDays: 1 },
      { stage: "PACKING", person: p.packerB, orders: 1, units: 1, activeDays: 1 },
      { stage: "QA", person: p.qa, orders: 1, units: 4, activeDays: 1 },
      { stage: "SHIPPING", person: p.system, orders: 1, units: 2, activeDays: 1 },
    ]);
    expect(report.persons).toEqual([p.packerA, p.packerB, p.picker, p.qa, p.system]);
  });

  it("fills every day of the range, even an empty one", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    const report = await throughput(db, admin, { ...range, to: "2026-11-04" });
    expect(report.days.map((d) => d.day)).toEqual(["2026-11-02", "2026-11-03", "2026-11-04"]);
    expect(report.rows).toEqual([]);
  });

  it("applies the stage and person filters, but not to the warehouse row or the person list", async () => {
    const p = await seed();
    const admin = await createActor(db, ["ADMIN"]);

    const packing = await throughput(db, admin, { ...range, stage: "PACKING" });
    expect(packing.rows.map((r) => r.person.name)).toEqual(["Ana Packer", "Ben Packer"]);
    expect(packing.people.map((r) => r.stage)).toEqual(["PACKING", "PACKING"]);
    expect(packing.days[0]).toEqual({ day: "2026-11-02", imported: 1, shipped: 1 });
    expect(packing.persons).toHaveLength(5);

    const ben = await throughput(db, admin, { ...range, person: p.packerB.id });
    expect(ben.rows).toEqual([
      { day: "2026-11-02", stage: "PACKING", person: p.packerB, orders: 1, units: 1 },
    ]);

    const system = await throughput(db, admin, { ...range, person: "system" });
    expect(system.rows).toEqual([
      { day: "2026-11-02", stage: "SHIPPING", person: p.system, orders: 1, units: 2 },
    ]);
  });

  it("refuses a range that isn't one", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    await expect(
      throughput(db, admin, { from: "2026-11-05", to: "2026-11-01", timeZone }),
    ).rejects.toMatchObject({ kind: "BAD_REQUEST" });
  });

  it("is report.read: Admin and a Packer with Reports, not the floor roles alone", async () => {
    const allowed: Role[][] = [["ADMIN"], ["PACKER", "REPORTS"]];
    for (const roles of allowed) {
      const actor = await createActor(db, roles);
      await expect(throughput(db, actor, range)).resolves.toBeDefined();
    }
    for (const role of ["PICKER", "PACKER", "QA", "SHIPPER", "RATE_LAB"] as const) {
      const actor = await createActor(db, [role]);
      await expect(throughput(db, actor, range)).rejects.toBeInstanceOf(AppError);
      await expect(throughput(db, actor, range)).rejects.toMatchObject({ kind: "FORBIDDEN" });
    }
  });
});

describe("throughputCsv", () => {
  async function lines(csv: Awaited<ReturnType<typeof throughputCsv>>): Promise<string[]> {
    const bytes = new Uint8Array(await new Response(csvStream(csv.header, csv.rows)).arrayBuffer());
    return new TextDecoder().decode(bytes.slice(3)).split("\r\n").slice(0, -1);
  }

  it("writes day, stage, person, orders and units with the screen's filters", async () => {
    await seed();
    const admin = await createActor(db, ["ADMIN"]);

    const all = await throughputCsv(db, admin, range, { locale: "en" });
    expect(all.filename).toBe("woolrus-throughput-2026-11-02-2026-11-03.csv");
    expect(await lines(all)).toEqual([
      "Day,Stage,Person,Orders,Units",
      "2026-11-02,PICKING,Pat Picker,1,2",
      "2026-11-02,PACKING,Ana Packer,1,3",
      "2026-11-02,PACKING,Ben Packer,1,1",
      "2026-11-02,QA,Quinn QA,1,4",
      "2026-11-02,SHIPPING,System,1,2",
      "2026-11-03,PICKING,Pat Picker,1,1",
    ]);

    const qa = await throughputCsv(db, admin, { ...range, stage: "QA" }, { locale: "es" });
    expect(await lines(qa)).toEqual([
      "Día,Etapa,Persona,Pedidos,Unidades",
      "2026-11-02,QA,Quinn QA,1,4",
    ]);
  });

  it("ends with the cut row past the cap", async () => {
    await seed();
    const admin = await createActor(db, ["ADMIN"]);
    const csv = await throughputCsv(db, admin, range, { locale: "en", cap: 2 });
    const out = await lines(csv);
    expect(out).toHaveLength(4);
    expect(out.at(-1)).toMatch(/^"Export cut at 2 rows/);
  });

  it("is report.read", async () => {
    const packer = await createActor(db, ["PACKER"]);
    await expect(throughputCsv(db, packer, range, { locale: "en" })).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
    const lead = await createActor(db, ["PACKER", "REPORTS"]);
    await expect(throughputCsv(db, lead, range, { locale: "en" })).resolves.toBeDefined();
  });
});

describe("indexes", () => {
  it("has the time indexes the read needs", async () => {
    const rows = await db.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE schemaname = 'public'`;
    const defs = rows.map((r) => r.indexdef);
    for (const [table, column] of [
      ["order_items", "picked_at"],
      ["package_items", "packed_at"],
      ["package_items", "qa_verified_at"],
      ["order_stage_events", "at"],
    ]) {
      expect(defs).toContain(
        `CREATE INDEX ${table}_${column}_idx ON public.${table} USING btree (${column})`,
      );
    }
    expect(defs).toContain(
      "CREATE INDEX audit_events_entity_type_at_idx ON public.audit_events USING btree (entity_type, at)",
    );
  });
});
