import type { Db, Role } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import { csvStream } from "../csv";
import { stationOnlyPlaceholder } from "../identity/station-only";
import type { CsvExport } from "../rate-lab/exports";
import { quality } from "./quality";
import { throughput } from "./throughput";
import { usersCsv } from "./users";

// SPEC-reporting "CSV exports": the users export, one row per user with the account columns and,
// for the range, orders and units per stage (as Throughput counts them), issues they were
// responsible for and their blocked scans (as Quality counts them). America/Chicago is UTC-6 in
// November.

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const timeZone = "America/Chicago";
const range = { from: "2026-11-02", to: "2026-11-08", timeZone };
const at = (iso: string) => new Date(iso);

async function lines(csv: CsvExport): Promise<string[]> {
  const bytes = new Uint8Array(await new Response(csvStream(csv.header, csv.rows)).arrayBuffer());
  return new TextDecoder().decode(bytes.slice(3)).split("\r\n").slice(0, -1);
}

async function user(
  name: string,
  data: { roles?: Role[]; active?: boolean; email?: string; createdAt?: string } = {},
) {
  return db.user.create({
    data: {
      name,
      email: data.email ?? `${name.split(" ")[0]?.toLowerCase()}@example.test`,
      roles: data.roles ?? [],
      active: data.active ?? true,
      createdAt: at(data.createdAt ?? "2026-10-01T15:00:00Z"),
    },
  });
}

/**
 * Pat picks 30 units of order 3001 and moves it to Packing; Ana (since deactivated) packs them and
 * moves it to QA. Pat is responsible for two issues in the range and one before it, and has two
 * blocked scans in it and one after. Sam is station-only with one blocked scan; Zoe did nothing.
 */
async function seed() {
  const pat = await user("Pat Picker", { roles: ["PICKER"] });
  const ana = await user("Ana Packer", { roles: ["PACKER", "QA"], active: false });
  const sam = await user("Sam Station", { roles: ["PICKER"], email: stationOnlyPlaceholder() });
  await user("Zoe Idle", { roles: ["SHIPPER"], createdAt: "2026-11-01T05:30:00Z" });

  const { order } = await createOrder(db, {
    number: "3001",
    status: "QA",
    lines: [{ quantity: 30, pickStatus: "PICKED" }],
    packages: [{ items: [{ line: 0, quantity: 30 }] }],
  });
  await db.orderItem.updateMany({
    where: { orderId: order.id },
    data: { pickedById: pat.id, pickedAt: at("2026-11-02T15:00:00Z") },
  });
  await db.packageItem.updateMany({
    where: { package: { orderId: order.id } },
    data: { packedById: ana.id, packedAt: at("2026-11-03T15:00:00Z") },
  });
  await db.orderStageEvent.createMany({
    data: [
      {
        orderId: order.id,
        fromStatus: "PICKING",
        toStatus: "PACKING",
        actorId: pat.id,
        at: at("2026-11-02T15:05:00Z"),
      },
      {
        orderId: order.id,
        fromStatus: "PACKING",
        toStatus: "QA",
        actorId: ana.id,
        at: at("2026-11-03T15:05:00Z"),
      },
    ],
  });

  const issue = (createdAt: string) =>
    db.qualityIssue.create({
      data: {
        orderId: order.id,
        type: "WRONG_ITEM",
        severity: "MINOR",
        discoveredStage: "PACKING",
        originStage: "PICKING",
        responsibleUserId: pat.id,
        description: "seeded",
        createdAt: at(createdAt),
      },
    });
  await issue("2026-11-02T16:00:00Z");
  await issue("2026-11-04T16:00:00Z");
  await issue("2026-11-02T05:30:00Z"); // Nov 1 local: outside

  const miss = (actorId: string, when: string) =>
    db.scanMiss.create({
      data: {
        orderId: order.id,
        stage: "PICKING",
        kind: "NOT_ON_ORDER",
        code: "111",
        actorId,
        at: at(when),
      },
    });
  await miss(pat.id, "2026-11-02T15:01:00Z");
  await miss(pat.id, "2026-11-02T15:02:00Z");
  await miss(pat.id, "2026-11-09T07:00:00Z"); // Nov 9 local: outside
  await miss(sam.id, "2026-11-05T15:00:00Z");
  return { pat, ana, sam };
}

const HEADER =
  "Name,Email,Roles,Active,Station-only,Created,Picking orders,Picking units,Packing orders,Packing units,QA orders,QA units,Shipping orders,Shipping units,Issues responsible,Blocked scans";

describe("usersCsv", () => {
  it("writes one row per user, by name, with the range's work", async () => {
    await seed();
    const admin = await createActor(db, ["ADMIN"]);
    await db.user.update({
      where: { id: admin.userId },
      data: {
        name: "Test Admin",
        email: "admin@example.test",
        createdAt: at("2026-09-01T12:00:00Z"),
      },
    });

    const csv = await usersCsv(db, admin, range, { locale: "en" });
    expect(csv.filename).toBe("woolrus-users-2026-11-02-2026-11-08.csv");
    expect(await lines(csv)).toEqual([
      HEADER,
      "Ana Packer,ana@example.test,PACKER QA,no,no,2026-10-01T10:00:00-05:00,0,0,1,30,0,0,0,0,0,0",
      "Pat Picker,pat@example.test,PICKER,yes,no,2026-10-01T10:00:00-05:00,1,30,0,0,0,0,0,0,2,2",
      "Sam Station,,PICKER,yes,yes,2026-10-01T10:00:00-05:00,0,0,0,0,0,0,0,0,0,1",
      "Test Admin,admin@example.test,ADMIN,yes,no,2026-09-01T07:00:00-05:00,0,0,0,0,0,0,0,0,0,0",
      "Zoe Idle,zoe@example.test,SHIPPER,yes,no,2026-11-01T00:30:00-05:00,0,0,0,0,0,0,0,0,0,0",
    ]);
  });

  it("matches Throughput per stage and Quality's issues and blocked scans", async () => {
    await seed();
    const admin = await createActor(db, ["ADMIN"]);
    const [csv, work, issues] = await Promise.all([
      usersCsv(db, admin, range, { locale: "en" }),
      throughput(db, admin, range),
      quality(db, admin, range),
    ]);
    const users = await db.user.findMany({ select: { id: true, name: true } });
    const nameOf = new Map(users.map((u) => [u.id, u.name]));
    const rows = new Map((await lines(csv)).slice(1).map((r) => [r.split(",")[0], r.split(",")]));

    const stages = ["PICKING", "PACKING", "QA", "SHIPPING"] as const;
    for (const total of work.people) {
      if (!total.person.id) continue;
      const row = rows.get(nameOf.get(total.person.id));
      const col = 6 + stages.indexOf(total.stage) * 2;
      expect(Number(row?.[col])).toBe(total.orders);
      expect(Number(row?.[col + 1])).toBe(total.units);
    }
    for (const total of issues.byPerson.totals) {
      if (!total.key) continue;
      expect(Number(rows.get(nameOf.get(total.key))?.[14])).toBe(total.count);
    }
    for (const scan of issues.scans) {
      if (!scan.person.id) continue;
      const count = scan.notOnOrder + scan.alreadyDone + scan.otherPackage + scan.unknownCode;
      expect(Number(rows.get(nameOf.get(scan.person.id))?.[15])).toBe(count);
    }
  });

  it("writes Spanish headers and ends with the cut row past the cap", async () => {
    await seed();
    const admin = await createActor(db, ["ADMIN"]);
    const out = await lines(await usersCsv(db, admin, range, { locale: "es", cap: 2 }));
    expect(out[0]).toMatch(/^Nombre,/);
    expect(out).toHaveLength(4);
    expect(out.at(-1)).toMatch(/^"Exportación cortada en 2 filas/);
  });

  it("defuses a name that reads as a formula", async () => {
    await user("=HYPERLINK(1)");
    const admin = await createActor(db, ["ADMIN"]);
    const out = await lines(await usersCsv(db, admin, range, { locale: "en" }));
    expect(out[1]).toMatch(/^'=HYPERLINK\(1\),/);
  });

  it("is report.read", async () => {
    for (const role of ["PICKER", "PACKER", "QA", "SHIPPER", "RATE_LAB"] as const) {
      const actor = await createActor(db, [role]);
      await expect(usersCsv(db, actor, range, { locale: "en" })).rejects.toMatchObject({
        kind: "FORBIDDEN",
      });
    }
    const lead = await createActor(db, ["PACKER", "REPORTS"]);
    await expect(usersCsv(db, lead, range, { locale: "en" })).resolves.toBeDefined();
  });

  it("refuses a range longer than 92 days", async () => {
    const admin = await createActor(db, ["ADMIN"]);
    await expect(
      usersCsv(db, admin, { from: "2026-01-01", to: "2026-12-31", timeZone }, { locale: "en" }),
    ).rejects.toMatchObject({ kind: "BAD_REQUEST" });
  });
});
