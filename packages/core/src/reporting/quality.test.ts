import type { QualityInput } from "@woolrus/contracts";
import type { Db, Role } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import { csvStream } from "../csv";
import { quality, qualityCsv, scanMissesCsv } from "./quality";
import { throughput } from "./throughput";

// SPEC-reporting "Quality" (criterion 3, and 7 for permissions): issues per week by type, discovered
// stage, origin stage and responsible person; the per-person rate with its 100-unit floor; blocked
// scans with UNKNOWN_CODE apart; voids by stage and resolution. America/Chicago is UTC-6 in
// November, so 05:30Z is 23:30 the local day before.

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const timeZone = "America/Chicago";
/** Three weeks, Monday Nov 2 to Sunday Nov 22: week buckets. */
const range = { from: "2026-11-02", to: "2026-11-22", timeZone };
const at = (iso: string) => new Date(iso);

async function user(name: string) {
  return db.user.create({ data: { name, email: `${crypto.randomUUID()}@example.test` } });
}

/**
 * Pat picked 200 units and Ana packed 50 in the range. Five issues land in it: two from Pat's
 * picking (week of Nov 2), two from Ana's packing (week of Nov 9, one at 23:30 local on Sunday
 * Nov 15), and one with no origin or responsible person (week of Nov 16). One more falls on
 * Nov 1 local, outside. Blocked scans and voids likewise, with one of each outside and an undone
 * void.
 */
async function seed() {
  const [pat, ana] = await Promise.all(["Pat Picker", "Ana Packer"].map(user));
  if (!pat || !ana) throw new Error("seed users");
  const station = await db.station.create({ data: { name: "Bench 1", tokenHash: "t-1" } });

  const picked = await createOrder(db, {
    number: "2001",
    status: "PACKING",
    lines: [{ quantity: 200, pickStatus: "PICKED" }],
  });
  await db.orderItem.updateMany({
    where: { orderId: picked.order.id },
    data: { pickedById: pat.id, pickedAt: at("2026-11-02T15:00:00Z") },
  });
  const packed = await createOrder(db, {
    number: "2002",
    status: "QA",
    lines: [{ quantity: 50, pickStatus: "PICKED" }],
    packages: [{ items: [{ line: 0, quantity: 50 }] }],
  });
  // Throughput credits packing from the audit row Pack remaining writes.
  const box = await db.package.findFirstOrThrow({
    where: { orderId: packed.order.id },
    include: { items: true },
  });
  await db.auditEvent.create({
    data: {
      actorId: ana.id,
      entityType: "Package",
      entityId: box.id,
      action: "package.packRemaining",
      before: { items: [] },
      after: {
        items: box.items.map((it) => ({ orderItemId: it.orderItemId, quantity: it.quantity })),
      },
      at: at("2026-11-09T15:00:00Z"),
    },
  });

  const issue = (data: {
    orderId: string;
    createdAt: string;
    type: "WRONG_ITEM" | "WRONG_QUANTITY" | "DAMAGED_ITEM" | "PACKAGING_DAMAGE" | "OTHER";
    severity: "MINOR" | "MAJOR" | "CRITICAL";
    status?: "OPEN" | "RESOLVED" | "DISMISSED";
    discoveredStage: "PACKING" | "QA" | "SHIPPING" | "CUSTOMER";
    originStage?: "PICKING" | "PACKING";
    responsibleUserId?: string;
    customerReported?: boolean;
    resolvedAt?: string;
  }) =>
    db.qualityIssue.create({
      data: {
        ...data,
        description: "seeded",
        createdAt: at(data.createdAt),
        resolvedAt: data.resolvedAt ? at(data.resolvedAt) : null,
      },
    });
  const p = picked.order.id;
  const k = packed.order.id;
  await issue({
    orderId: p,
    createdAt: "2026-11-02T16:00:00Z",
    type: "WRONG_ITEM",
    severity: "MAJOR",
    discoveredStage: "PACKING",
    originStage: "PICKING",
    responsibleUserId: pat.id,
  });
  await issue({
    orderId: p,
    createdAt: "2026-11-03T16:00:00Z",
    type: "WRONG_QUANTITY",
    severity: "MINOR",
    status: "RESOLVED",
    discoveredStage: "QA",
    originStage: "PICKING",
    responsibleUserId: pat.id,
    resolvedAt: "2026-11-04T16:00:00Z",
  });
  await issue({
    orderId: k,
    createdAt: "2026-11-10T05:30:00Z",
    type: "DAMAGED_ITEM",
    severity: "CRITICAL",
    discoveredStage: "QA",
    originStage: "PACKING",
    responsibleUserId: ana.id,
  });
  await issue({
    orderId: k,
    createdAt: "2026-11-16T05:30:00Z",
    type: "PACKAGING_DAMAGE",
    severity: "MINOR",
    status: "DISMISSED",
    discoveredStage: "CUSTOMER",
    originStage: "PACKING",
    responsibleUserId: ana.id,
    customerReported: true,
  });
  await issue({
    orderId: k,
    createdAt: "2026-11-17T16:00:00Z",
    type: "OTHER",
    severity: "MINOR",
    discoveredStage: "SHIPPING",
  });
  await issue({
    orderId: p,
    createdAt: "2026-11-02T05:30:00Z",
    type: "WRONG_ITEM",
    severity: "MAJOR",
    discoveredStage: "PACKING",
    originStage: "PICKING",
    responsibleUserId: pat.id,
  });

  const miss = (data: {
    orderId: string;
    at: string;
    stage: "PICKING" | "PACKING" | "QA";
    kind: "NOT_ON_ORDER" | "UNKNOWN_CODE" | "ALREADY_DONE" | "OTHER_PACKAGE";
    code: string;
    productName?: string;
    actorId?: string;
    stationId?: string;
  }) => db.scanMiss.create({ data: { ...data, at: at(data.at) } });
  await miss({
    orderId: p,
    at: "2026-11-02T15:10:00Z",
    stage: "PICKING",
    kind: "NOT_ON_ORDER",
    code: "111",
    productName: "Blue mug",
    actorId: pat.id,
    stationId: station.id,
  });
  await miss({
    orderId: p,
    at: "2026-11-02T15:20:00Z",
    stage: "PICKING",
    kind: "UNKNOWN_CODE",
    code: "999",
    actorId: pat.id,
  });
  await miss({
    orderId: p,
    at: "2026-11-03T15:20:00Z",
    stage: "PICKING",
    kind: "UNKNOWN_CODE",
    code: "998",
    actorId: pat.id,
  });
  await miss({
    orderId: k,
    at: "2026-11-09T15:10:00Z",
    stage: "PACKING",
    kind: "ALREADY_DONE",
    code: "222",
    actorId: ana.id,
  });
  await miss({
    orderId: k,
    at: "2026-11-10T15:10:00Z",
    stage: "QA",
    kind: "OTHER_PACKAGE",
    code: "333",
  });
  await miss({
    orderId: p,
    at: "2026-11-02T05:30:00Z",
    stage: "PICKING",
    kind: "NOT_ON_ORDER",
    code: "000",
    actorId: pat.id,
  });

  // On an order of their own, so Pat's picked units stay whole.
  const voided = await createOrder(db, { number: "2003", lines: [{ quantity: 10 }] });
  const line = voided.items[0];
  if (!line) throw new Error("seed line");
  const voids = [
    { stage: "PICKING", quantity: 2, resolution: "REFUNDED", voidedAt: "2026-11-02T17:00:00Z" },
    { stage: "PICKING", quantity: 1, voidedAt: "2026-11-03T17:00:00Z" },
    {
      stage: "PACKING",
      quantity: 1,
      resolution: "HANDLED_MANUALLY",
      voidedAt: "2026-11-10T17:00:00Z",
    },
    {
      stage: "PACKING",
      quantity: 4,
      voidedAt: "2026-11-10T18:00:00Z",
      undoneAt: "2026-11-10T18:05:00Z",
    },
    { stage: "PICKING", quantity: 1, voidedAt: "2026-11-02T05:30:00Z" },
  ] as const;
  for (const v of voids)
    await db.itemVoid.create({
      data: {
        orderId: voided.order.id,
        orderItemId: line.id,
        reason: "seeded",
        stage: v.stage,
        quantity: v.quantity,
        resolution: "resolution" in v ? v.resolution : null,
        voidedAt: at(v.voidedAt),
        undoneAt: "undoneAt" in v ? at(v.undoneAt) : null,
      },
    });

  return {
    pat: { id: pat.id, name: pat.name },
    ana: { id: ana.id, name: ana.name },
    nobody: { id: null, name: null },
  };
}

describe("quality", () => {
  it("counts issues per week by type, stage and responsible person, exactly", async () => {
    const p = await seed();
    const admin = await createActor(db, ["ADMIN"]);

    const report = await quality(db, admin, range);

    expect(report.bucketSize).toBe("week");
    expect(report.buckets).toEqual(["2026-11-02", "2026-11-09", "2026-11-16"]);
    expect(report.total).toBe(5);
    expect(report.byType).toEqual({
      series: [
        { bucket: "2026-11-02", key: "WRONG_ITEM", count: 1 },
        { bucket: "2026-11-02", key: "WRONG_QUANTITY", count: 1 },
        // 23:30 on Sunday Nov 15 local is still the week of Nov 9.
        { bucket: "2026-11-09", key: "DAMAGED_ITEM", count: 1 },
        { bucket: "2026-11-09", key: "PACKAGING_DAMAGE", count: 1 },
        { bucket: "2026-11-16", key: "OTHER", count: 1 },
      ],
      totals: [
        { key: "WRONG_ITEM", count: 1 },
        { key: "DAMAGED_ITEM", count: 1 },
        { key: "WRONG_QUANTITY", count: 1 },
        { key: "PACKAGING_DAMAGE", count: 1 },
        { key: "OTHER", count: 1 },
      ],
    });
    expect(report.byDiscoveredStage.totals).toEqual([
      { key: "QA", count: 2 },
      { key: "PACKING", count: 1 },
      { key: "SHIPPING", count: 1 },
      { key: "CUSTOMER", count: 1 },
    ]);
    expect(report.byOriginStage).toEqual({
      series: [
        { bucket: "2026-11-02", key: "PICKING", count: 2 },
        { bucket: "2026-11-09", key: "PACKING", count: 2 },
        { bucket: "2026-11-16", key: null, count: 1 },
      ],
      totals: [
        { key: "PICKING", count: 2 },
        { key: "PACKING", count: 2 },
        { key: null, count: 1 },
      ],
    });
    expect(report.byPerson).toEqual({
      series: [
        { bucket: "2026-11-02", key: p.pat.id, count: 2 },
        { bucket: "2026-11-09", key: p.ana.id, count: 2 },
        { bucket: "2026-11-16", key: null, count: 1 },
      ],
      totals: [
        { key: p.ana.id, count: 2 },
        { key: p.pat.id, count: 2 },
        { key: null, count: 1 },
      ],
    });
  });

  it("buckets by day for ranges of 14 days or fewer", async () => {
    await seed();
    const admin = await createActor(db, ["ADMIN"]);

    const two = await quality(db, admin, { from: "2026-11-02", to: "2026-11-03", timeZone });
    expect(two.bucketSize).toBe("day");
    expect(two.buckets).toEqual(["2026-11-02", "2026-11-03"]);
    expect(two.byType.series).toEqual([
      { bucket: "2026-11-02", key: "WRONG_ITEM", count: 1 },
      { bucket: "2026-11-03", key: "WRONG_QUANTITY", count: 1 },
    ]);

    const fourteen = await quality(db, admin, { from: "2026-11-02", to: "2026-11-15", timeZone });
    expect(fourteen.bucketSize).toBe("day");
    expect(fourteen.buckets).toHaveLength(14);
    const fifteen = await quality(db, admin, { from: "2026-11-02", to: "2026-11-16", timeZone });
    expect(fifteen.bucketSize).toBe("week");
  });

  it("applies the severity, customer-reported and status filters", async () => {
    await seed();
    const admin = await createActor(db, ["ADMIN"]);
    const types = async (filters: Partial<QualityInput>) =>
      (await quality(db, admin, { ...range, ...filters })).byType.totals.map((t) => t.key);

    expect(await types({ severity: "MINOR" })).toEqual([
      "WRONG_QUANTITY",
      "PACKAGING_DAMAGE",
      "OTHER",
    ]);
    expect(await types({ customerReported: true })).toEqual(["PACKAGING_DAMAGE"]);
    expect(await types({ status: "open" })).toEqual(["WRONG_ITEM", "DAMAGED_ITEM", "OTHER"]);
    // Resolved includes dismissed, as on the Issues list.
    expect(await types({ status: "resolved" })).toEqual(["WRONG_QUANTITY", "PACKAGING_DAMAGE"]);
    const filtered = await quality(db, admin, { ...range, severity: "CRITICAL" });
    expect(filtered.total).toBe(1);
    expect(filtered.people.map((r) => r.issues)).toEqual([1]);
  });

  it("rates each person per 1,000 units they handled in the stage, from 100 units", async () => {
    const p = await seed();
    const admin = await createActor(db, ["ADMIN"]);

    const report = await quality(db, admin, range);

    expect(report.people).toEqual([
      // 50 packed units: under the floor, so no rate.
      { person: p.ana, stage: "PACKING", issues: 2, units: 50, per1000: null },
      { person: p.pat, stage: "PICKING", issues: 2, units: 200, per1000: 10 },
    ]);
  });

  it("takes the rate's units from Throughput", async () => {
    const p = await seed();
    const admin = await createActor(db, ["ADMIN"]);

    const { people } = await throughput(db, admin, range);
    const report = await quality(db, admin, range);

    for (const row of report.people) {
      const units = people.find((t) => t.person.id === row.person.id && t.stage === row.stage);
      expect(row.units).toBe(units?.units);
    }
    expect(report.people.find((r) => r.person.id === p.pat.id)?.units).toBe(200);
  });

  it("counts blocked scans by stage, kind and person, with unknown barcodes apart", async () => {
    const p = await seed();
    const admin = await createActor(db, ["ADMIN"]);

    const report = await quality(db, admin, range);

    const zero = { notOnOrder: 0, alreadyDone: 0, otherPackage: 0, unknownCode: 0 };
    expect(report.scans).toEqual([
      { stage: "PICKING", person: p.pat, ...zero, notOnOrder: 1, unknownCode: 2 },
      { stage: "PACKING", person: p.ana, ...zero, alreadyDone: 1 },
      { stage: "QA", person: p.nobody, ...zero, otherPackage: 1 },
    ]);
  });

  it("counts voids by stage and resolution, leaving out undone ones", async () => {
    await seed();
    const admin = await createActor(db, ["ADMIN"]);

    const report = await quality(db, admin, range);

    expect(report.voids).toEqual([
      { stage: "PICKING", resolution: "REFUNDED", voids: 1, units: 2 },
      { stage: "PICKING", resolution: null, voids: 1, units: 1 },
      { stage: "PACKING", resolution: "HANDLED_MANUALLY", voids: 1, units: 1 },
    ]);
  });

  it("doesn't filter scans or voids by the issue filters", async () => {
    await seed();
    const admin = await createActor(db, ["ADMIN"]);
    const all = await quality(db, admin, range);
    const critical = await quality(db, admin, { ...range, severity: "CRITICAL" });
    expect(critical.scans).toEqual(all.scans);
    expect(critical.voids).toEqual(all.voids);
  });

  it("refuses a range that isn't one", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    await expect(
      quality(db, admin, { from: "2026-11-05", to: "2026-11-01", timeZone }),
    ).rejects.toMatchObject({ kind: "BAD_REQUEST" });
  });

  it("is report.read: Admin and a Packer with Reports, not the floor roles alone", async () => {
    const allowed: Role[][] = [["ADMIN"], ["PACKER", "REPORTS"]];
    for (const roles of allowed) {
      const actor = await createActor(db, roles);
      await expect(quality(db, actor, range)).resolves.toBeDefined();
    }
    for (const role of ["PICKER", "PACKER", "QA", "SHIPPER", "RATE_LAB"] as const) {
      const actor = await createActor(db, [role]);
      await expect(quality(db, actor, range)).rejects.toMatchObject({ kind: "FORBIDDEN" });
    }
  });
});

async function lines(csv: Awaited<ReturnType<typeof qualityCsv>>): Promise<string[]> {
  const bytes = new Uint8Array(await new Response(csvStream(csv.header, csv.rows)).arrayBuffer());
  return new TextDecoder().decode(bytes.slice(3)).split("\r\n").slice(0, -1);
}

describe("qualityCsv", () => {
  it("writes one row per issue in the range, oldest first, with the screen's filters", async () => {
    await seed();
    const admin = await createActor(db, ["ADMIN"]);

    const all = await qualityCsv(db, admin, range, { locale: "en" });
    expect(all.filename).toBe("woolrus-quality-2026-11-02-2026-11-22.csv");
    expect(await lines(all)).toEqual([
      "Order,Created,Type,Severity,Status,Discovered stage,Origin stage,Responsible,Customer-reported,Resolved at",
      "2001,2026-11-02T10:00:00-06:00,WRONG_ITEM,MAJOR,OPEN,PACKING,PICKING,Pat Picker,no,",
      "2001,2026-11-03T10:00:00-06:00,WRONG_QUANTITY,MINOR,RESOLVED,QA,PICKING,Pat Picker,no,2026-11-04T10:00:00-06:00",
      "2002,2026-11-09T23:30:00-06:00,DAMAGED_ITEM,CRITICAL,OPEN,QA,PACKING,Ana Packer,no,",
      "2002,2026-11-15T23:30:00-06:00,PACKAGING_DAMAGE,MINOR,DISMISSED,CUSTOMER,PACKING,Ana Packer,yes,",
      "2002,2026-11-17T10:00:00-06:00,OTHER,MINOR,OPEN,SHIPPING,,,no,",
    ]);

    const customer = await qualityCsv(
      db,
      admin,
      { ...range, customerReported: "true", status: "resolved" },
      { locale: "es" },
    );
    const out = await lines(customer);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatch(/^2002,2026-11-15T23:30:00-06:00,PACKAGING_DAMAGE,/);
  });

  it("ends with the cut row past the cap", async () => {
    await seed();
    const admin = await createActor(db, ["ADMIN"]);
    const out = await lines(await qualityCsv(db, admin, range, { locale: "en", cap: 2 }));
    expect(out).toHaveLength(4);
    expect(out.at(-1)).toMatch(/^"Export cut at 2 rows/);
  });

  it("is report.read", async () => {
    const packer = await createActor(db, ["PACKER"]);
    await expect(qualityCsv(db, packer, range, { locale: "en" })).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
    const lead = await createActor(db, ["PACKER", "REPORTS"]);
    await expect(qualityCsv(db, lead, range, { locale: "en" })).resolves.toBeDefined();
  });
});

describe("scanMissesCsv", () => {
  it("writes one row per blocked scan in the range, oldest first", async () => {
    await seed();
    const admin = await createActor(db, ["ADMIN"]);

    const csv = await scanMissesCsv(db, admin, range, { locale: "en" });
    expect(csv.filename).toBe("woolrus-scan-misses-2026-11-02-2026-11-22.csv");
    expect(await lines(csv)).toEqual([
      "Order,Scanned at,Stage,Kind,Code,Product,Person,Station",
      "2001,2026-11-02T09:10:00-06:00,PICKING,NOT_ON_ORDER,111,Blue mug,Pat Picker,Bench 1",
      "2001,2026-11-02T09:20:00-06:00,PICKING,UNKNOWN_CODE,999,,Pat Picker,",
      "2001,2026-11-03T09:20:00-06:00,PICKING,UNKNOWN_CODE,998,,Pat Picker,",
      "2002,2026-11-09T09:10:00-06:00,PACKING,ALREADY_DONE,222,,Ana Packer,",
      "2002,2026-11-10T09:10:00-06:00,QA,OTHER_PACKAGE,333,,,",
    ]);
  });

  it("is report.read", async () => {
    const qa = await createActor(db, ["QA"]);
    await expect(scanMissesCsv(db, qa, range, { locale: "en" })).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
  });
});

describe("indexes", () => {
  it("has the blocked-scan time index the read needs", async () => {
    const rows = await db.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'scan_misses'`;
    expect(rows.map((r) => r.indexdef)).toContain(
      "CREATE INDEX scan_misses_at_idx ON public.scan_misses USING btree (at)",
    );
  });
});
