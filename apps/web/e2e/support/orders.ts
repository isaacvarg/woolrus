import { createDb, type WorkflowStatus } from "@woolrus/db";

const db = createDb();

const address = {
  name: "E2E Customer",
  address1: "1 Main St",
  city: "Austin",
  state: "TX",
  postalCode: "78701",
  country: "US",
};

// Far above the demo seed's 9,000,001+ and anything the dev store will reach; random because the
// desktop and tablet projects create orders at the same time.
const nextWooId = () => 1_000_000_000 + Math.floor(Math.random() * 1_000_000_000);

/** Orders this worker created, for `deleteCreatedOrders`. */
const created: string[] = [];

/**
 * Creates an order straight in the database, as `store-sync` would import it. Each test gives it a
 * unique customer name and searches for it, so tests running in parallel never see each other's
 * orders (or the demo seed's) in a queue.
 */
export async function createOrder({
  customerName = `E2E ${crypto.randomUUID()}`,
  status = "PENDING",
  priority = 0,
  quantity = 2,
  statusChangedAt = new Date(),
}: {
  customerName?: string;
  status?: WorkflowStatus;
  priority?: number;
  quantity?: number;
  statusChangedAt?: Date;
} = {}) {
  const wooOrderId = nextWooId();
  const now = new Date();
  const order = await db.order.create({
    data: {
      wooOrderId,
      number: String(wooOrderId),
      wooStatus: "processing",
      currency: "USD",
      customerName,
      shippingAddress: address,
      billingAddress: address,
      totalCents: 1000,
      orderedAt: now,
      wooModifiedAt: now,
      syncedAt: now,
      rawPayload: {},
      status,
      statusChangedAt,
      priority,
      items: {
        create: {
          wooLineItemId: wooOrderId,
          sku: "E2E-SKU",
          name: "E2E item",
          quantity,
          unitPriceCents: 500,
        },
      },
    },
  });
  created.push(order.id);
  return order;
}

/**
 * Removes the orders this worker created (lines, events and packages cascade), so the dev stack's
 * queues keep showing the demo orders. Workers are separate processes, so another project's
 * orders are never touched while its tests still use them.
 */
export async function deleteCreatedOrders() {
  await db.order.deleteMany({ where: { id: { in: created.splice(0) } } });
}
