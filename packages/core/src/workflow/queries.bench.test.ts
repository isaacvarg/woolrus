import type { Db } from "@woolrus/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createActor, resetDb, testDb } from "../../test/db";
import type { Actor } from "../permissions";
import { type ListQueueInput, listQueue } from "./queries";

/**
 * SC 11 / NFR-PERF-01: with 2,000 open orders, a queue read stays under 1 s at p95. Orders are inserted
 * with plain SQL (the factories would take minutes at this size), skewed towards Pending the way a
 * morning backlog is, with three lines each, some non-physical lines, voids and live claims, so every
 * part of the query has rows to work on.
 */

const db: Db = testDb();
let picker: Actor;

const OPEN_ORDERS = 2_000;
const RUNS_PER_CASE = 20;

beforeAll(async () => {
  await resetDb(db);
  picker = await createActor(db, ["PICKER"]);

  await db.$executeRaw`
    INSERT INTO products (id, woo_product_id, type, name, sku, physical, raw_payload, synced_at, updated_at)
    SELECT gen_random_uuid(), n, 'simple', 'Product ' || n, 'SKU-' || n, n % 25 <> 0, '{}', now(), now()
    FROM generate_series(1, 200) n`;

  // 80% Pending, the rest spread over the other open stages; every 50th order is claimed.
  await db.$executeRaw`
    INSERT INTO orders (id, woo_order_id, number, woo_status, currency, customer_name, customer_email,
      shipping_address, billing_address, total_cents, shipping_method, ordered_at, woo_modified_at,
      synced_at, raw_payload, status, status_changed_at, priority, hold_reason, held_from_status,
      claimed_by_id, claimed_at, updated_at)
    SELECT gen_random_uuid(), n, (10000 + n)::text, 'processing', 'USD',
      (ARRAY['Ana','Luis','Maria','John','Grace','Chen','Priya','Omar'])[1 + n % 8] || ' Customer ' || n,
      'c' || n || '@example.test', '{}', '{}', 2500,
      CASE WHEN n % 10 = 0 THEN 'Express' ELSE 'Flat rate' END,
      now() - make_interval(mins => n * 7), now(), now(), '{}',
      s.status::workflow_status, now() - make_interval(mins => n % 600), n % 3,
      CASE WHEN s.status = 'ON_HOLD' THEN 'Waiting on customer' END,
      CASE WHEN s.status = 'ON_HOLD' THEN 'PACKING'::workflow_status END,
      CASE WHEN n % 50 = 0 THEN ${picker.userId}::uuid END,
      CASE WHEN n % 50 = 0 THEN now() END,
      now()
    FROM generate_series(1, ${OPEN_ORDERS}) n,
      LATERAL (SELECT CASE
        WHEN n % 10 < 8 THEN 'PENDING'
        ELSE (ARRAY['PICKING','PACKING','QA','READY','ON_HOLD'])[1 + n % 5]
      END AS status) s`;

  await db.$executeRaw`
    INSERT INTO order_items (id, order_id, woo_line_item_id, product_id, name, sku, quantity,
      unit_price_cents, updated_at)
    SELECT gen_random_uuid(), o.id, o.woo_order_id * 10 + l, p.id, p.name, p.sku, 1 + l, 1000, now()
    FROM orders o
    CROSS JOIN generate_series(1, 3) l
    JOIN products p ON p.woo_product_id = 1 + (o.woo_order_id * 3 + l) % 200`;

  await db.$executeRaw`
    INSERT INTO item_voids (id, order_id, order_item_id, quantity, reason, stage, undone_at)
    SELECT gen_random_uuid(), i.order_id, i.id, 1, 'bench', 'PICKING',
      CASE WHEN i.woo_line_item_id % 3 = 0 THEN now() END
    FROM order_items i WHERE i.woo_line_item_id % 37 = 0`;

  await db.$executeRawUnsafe("ANALYZE");
}, 60_000);

afterAll(async () => {
  await resetDb(db);
  await db.$disconnect();
});

async function p95(input: ListQueueInput): Promise<number> {
  await listQueue(db, picker, input); // warm-up: connection and plan cache
  const times: number[] = [];
  for (let i = 0; i < RUNS_PER_CASE; i++) {
    const start = performance.now();
    await listQueue(db, picker, input);
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return times[Math.ceil(times.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
}

describe("listQueue with 2,000 open orders", () => {
  it("has the data the benchmark assumes", async () => {
    expect(await db.order.count()).toBe(OPEN_ORDERS);
    const page = await listQueue(db, picker, { stage: "PENDING", limit: 100 });
    expect(page.rows).toHaveLength(100);
    expect(page.nextCursor).not.toBeNull();
  });

  it.each<[string, Omit<ListQueueInput, "cursor">]>([
    ["the first page of Pending", { stage: "PENDING" }],
    ["a full page of 100", { stage: "PENDING", limit: 100 }],
    ["a customer search", { stage: "PENDING", search: "maria" }],
    ["a number prefix search", { stage: "PENDING", search: "#101" }],
    ["On Hold", { stage: "ON_HOLD" }],
  ])("reads %s under 1 s at p95", async (_name, input) => {
    expect(await p95(input)).toBeLessThan(1_000);
  });

  it("reads a deep page (keyset cursor) under 1 s at p95", async () => {
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = await listQueue(db, picker, { stage: "PENDING", limit: 100, cursor });
      cursor = page.nextCursor ?? undefined;
    }
    expect(cursor).toBeDefined();
    expect(await p95({ stage: "PENDING", limit: 100, cursor })).toBeLessThan(1_000);
  });
});
