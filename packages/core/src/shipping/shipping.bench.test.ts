import type { Db } from "@woolrus/db";
import { PDFDocument } from "pdf-lib";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import { createOrder } from "../../test/factories";
import { createMemoryStorage } from "../adapters/storage/memory";
import { listQueue } from "../workflow/queries";
import { createLabelPrint, labelPrintPdf } from "./print";
import { shipOrders } from "./ship";

// SPEC-shipping criterion 15. The budgets are the spec's; a machine under load can miss them, so the
// samples are few and the check is p95.

const db: Db = testDb();
afterAll(() => db.$disconnect());
beforeEach(async () => {
  await resetDb(db);
  await db.$executeRawUnsafe(`DELETE FROM pgboss.job WHERE name = 'woo.push'`);
});

const p95 = (ms: number[]) => [...ms].sort((a, b) => a - b)[Math.ceil(ms.length * 0.95) - 1] ?? 0;

async function time<T>(run: () => Promise<T>): Promise<number> {
  const start = performance.now();
  await run();
  return performance.now() - start;
}

describe("shipping performance", () => {
  it("ships 50 orders in under 2 s p95", async () => {
    const shipper = await createActor(db, ["SHIPPER"]);
    const samples: number[] = [];
    for (let run = 0; run < 5; run++) {
      const orderIds: string[] = [];
      for (let i = 0; i < 50; i++) {
        const built = await createOrder(db, { status: "READY", packages: [{ label: "ACTIVE" }] });
        orderIds.push(built.order.id);
      }
      await db.shippingLabel.updateMany({
        where: { package: { orderId: { in: orderIds } } },
        data: { printCount: 1 },
      });
      samples.push(
        await time(async () => {
          const { results } = await shipOrders(db, shipper, {
            orderIds,
            confirmUnprinted: false,
            idempotencyKey: crypto.randomUUID(),
          });
          expect(results.every((r) => r.ok)).toBe(true);
        }),
      );
    }
    expect(p95(samples)).toBeLessThan(2000);
  }, 120_000);

  it("streams a 150-label merged PDF in under 3 s", async () => {
    const shipper = await createActor(db, ["SHIPPER"]);
    const storage = createMemoryStorage();
    const orderIds: string[] = [];
    for (let i = 0; i < 50; i++) {
      const built = await createOrder(db, {
        status: "READY",
        packages: [{ label: "ACTIVE" }, { label: "ACTIVE" }, { label: "ACTIVE" }],
      });
      orderIds.push(built.order.id);
    }
    const page = await PDFDocument.create();
    page.addPage([288, 432]);
    const bytes = await page.save();
    const labels = await db.shippingLabel.findMany({
      where: { package: { orderId: { in: orderIds } } },
    });
    expect(labels).toHaveLength(150);
    for (const label of labels) {
      const key = `labels/${label.id}.pdf`;
      await storage.put(key, bytes, "application/pdf");
      await db.shippingLabel.update({ where: { id: label.id }, data: { storageKey: key } });
    }

    const samples: number[] = [];
    for (let run = 0; run < 3; run++) {
      samples.push(
        await time(async () => {
          const { printId, labelCount } = await createLabelPrint(db, shipper, {
            orderIds,
            idempotencyKey: `bench-${crypto.randomUUID()}`,
          });
          expect(labelCount).toBe(150);
          const pdf = await labelPrintPdf(db, shipper, storage, printId);
          expect((await PDFDocument.load(pdf)).getPageCount()).toBe(150);
        }),
      );
    }
    expect(p95(samples)).toBeLessThan(3000);
  }, 120_000);

  it("lists the Ready queue in under 300 ms p95 with 2,000 Ready orders", async () => {
    const shipper = await createActor(db, ["SHIPPER"]);
    await db.$executeRaw`
      INSERT INTO orders (id, woo_order_id, number, woo_status, currency, customer_name, customer_email,
        shipping_address, billing_address, total_cents, shipping_method, ordered_at, woo_modified_at,
        synced_at, raw_payload, status, status_changed_at, priority, updated_at)
      SELECT gen_random_uuid(), n, (10000 + n)::text, 'processing', 'USD', 'Customer ' || n,
        'c' || n || '@example.test', '{}', '{}', 2500, 'Flat rate',
        now() - make_interval(mins => n), now(), now(), '{}', 'READY', now() - make_interval(mins => n % 600),
        n % 3, now()
      FROM generate_series(1, 2000) n`;
    await db.$executeRaw`
      INSERT INTO packages (id, order_id, number, updated_at)
      SELECT gen_random_uuid(), o.id, p, now()
      FROM orders o CROSS JOIN generate_series(1, 2) p`;
    await db.$executeRaw`
      INSERT INTO shipping_labels (id, package_id, status, provider, idempotency_key, tracking_number,
        carrier_code, service_code, cost_cents, currency, print_count, updated_at)
      SELECT gen_random_uuid(), p.id, 'ACTIVE', 'SHIPSTATION', 'bench-' || p.id, 'TRK' || p.number,
        'usps', 'usps_ground_advantage', 650, 'USD', p.number % 2, now()
      FROM packages p`;
    await db.$executeRawUnsafe("ANALYZE");

    await listQueue(db, shipper, { stage: "READY", limit: 100 }); // warm-up
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      samples.push(await time(() => listQueue(db, shipper, { stage: "READY", limit: 100 })));
    }
    const page = await listQueue(db, shipper, { stage: "READY", limit: 100 });
    expect(page.rows).toHaveLength(100);
    expect(page.rows[0]).toMatchObject({ packageCount: 2 });
    expect(p95(samples)).toBeLessThan(300);
  }, 60_000);
});
