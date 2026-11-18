import { readFileSync } from "node:fs";
import type { Db, Prisma } from "@woolrus/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";

// SPEC-order-activity "Order on audit rows", success criterion 2. The test database is already
// migrated, so the test seeds rows as they were before the migration (no order_id, old entity type
// names) and replays the migration's backfill section against them.

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDb(db));

const migration = readFileSync(
  new URL(
    "../../../db/prisma/migrations/20261117100000_audit_order_id/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

async function runBackfill() {
  const section = /-- backfill:begin([\s\S]*)-- backfill:end/.exec(migration)?.[1];
  if (!section) throw new Error("migration has no backfill section");
  const statements = section
    .split(/;\s*$/m)
    .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
    .filter(Boolean);
  for (const sql of statements) await db.$executeRawUnsafe(sql);
}

async function audit(
  entityType: string,
  entityId: string,
  extra: { before?: Prisma.InputJsonValue; after?: Prisma.InputJsonValue } = {},
) {
  const row = await db.auditEvent.create({
    data: { entityType, entityId, action: "test", ...extra },
  });
  return row.id;
}

const orderOf = async (id: string) =>
  (await db.auditEvent.findUniqueOrThrow({ where: { id } })).orderId;

describe("audit order backfill", () => {
  it("maps each entity type to its order, as in the spec's table", async () => {
    const { order, items, packages } = await createOrder(db, {
      status: "QA",
      lines: [{ quantity: 2 }],
      packages: [{ items: [{ line: 0, quantity: 2 }], label: "ACTIVE" }],
    });
    const other = await createOrder(db, { status: "PENDING" });
    const line = items[0];
    const pkg = packages[0];
    if (!line || !pkg) throw new Error("fixture");
    const packageItem = await db.packageItem.findFirstOrThrow({ where: { packageId: pkg.id } });
    const label = await db.shippingLabel.findFirstOrThrow({ where: { packageId: pkg.id } });
    const trip = await db.packageCheckTrip.create({
      data: { packageId: pkg.id, check: "OVER_MAX", mode: "WARN" },
    });
    const itemVoid = await db.itemVoid.create({
      data: {
        orderId: order.id,
        orderItemId: line.id,
        quantity: 1,
        reason: "Broken",
        stage: "PICKING",
      },
    });
    const issue = await db.qualityIssue.create({
      data: {
        orderId: order.id,
        type: "DAMAGED_ITEM",
        severity: "MINOR",
        description: "Dented",
        discoveredStage: "QA",
      },
    });
    const note = await db.note.create({ data: { orderId: order.id, content: "Fragile" } });
    const deletedPackageId = crypto.randomUUID();

    const rows = {
      order: await audit("Order", order.id),
      lowercaseOrder: await audit("order", other.order.id),
      orderItem: await audit("OrderItem", line.id),
      itemVoid: await audit("ItemVoid", itemVoid.id),
      issue: await audit("QualityIssue", issue.id),
      note: await audit("Note", note.id),
      package: await audit("Package", pkg.id),
      trip: await audit("PackageCheckTrip", trip.id),
      packageItem: await audit("PackageItem", packageItem.id),
      label: await audit("ShippingLabel", label.id),
      approval: await audit("Approval", crypto.randomUUID(), {
        after: { kind: "weight", entityType: "Package", entityId: pkg.id },
      }),
      deletedPackage: await audit("Package", deletedPackageId, {
        before: { orderId: other.order.id, number: 2 },
      }),
      deletedWithAfter: await audit("PackageItem", crypto.randomUUID(), {
        after: { orderId: order.id },
      }),
    };
    const unmapped = {
      deletedNoHint: await audit("Package", crypto.randomUUID(), { before: { number: 3 } }),
      box: await audit("Box", crypto.randomUUID()),
      settings: await audit("Settings", "singleton"),
      badHint: await audit("Note", crypto.randomUUID(), { before: { orderId: "not-a-uuid" } }),
      approvalOfUser: await audit("Approval", crypto.randomUUID(), {
        after: { entityType: "User", entityId: crypto.randomUUID() },
      }),
    };

    await runBackfill();

    const expected: Record<keyof typeof rows, string> = {
      order: order.id,
      lowercaseOrder: other.order.id,
      orderItem: order.id,
      itemVoid: order.id,
      issue: order.id,
      note: order.id,
      package: order.id,
      trip: order.id,
      packageItem: order.id,
      label: order.id,
      approval: order.id,
      deletedPackage: other.order.id,
      deletedWithAfter: order.id,
    };
    for (const [name, id] of Object.entries(rows)) {
      expect({ name, orderId: await orderOf(id) }).toEqual({
        name,
        orderId: expected[name as keyof typeof rows],
      });
    }
    for (const [name, id] of Object.entries(unmapped)) {
      expect({ name, orderId: await orderOf(id) }).toEqual({ name, orderId: null });
    }
  });

  it("rewrites the lowercase entity types", async () => {
    const { order } = await createOrder(db);
    await audit("order", order.id);
    await audit("manifest", crypto.randomUUID());

    await runBackfill();

    const types = await db.auditEvent.findMany({ select: { entityType: true } });
    expect(types.map((t) => t.entityType).sort()).toEqual(["Manifest", "Order"]);
  });

  it("leaves rows that already carry an order alone", async () => {
    const a = await createOrder(db);
    const b = await createOrder(db);
    const row = await db.auditEvent.create({
      data: { entityType: "Order", entityId: a.order.id, action: "test", orderId: b.order.id },
    });

    await runBackfill();

    expect(await orderOf(row.id)).toBe(b.order.id);
  });
});
