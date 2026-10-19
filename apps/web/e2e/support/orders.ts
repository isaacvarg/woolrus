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
  orderedAt = new Date(),
  rushOrderLine = false,
  sku = "E2E-SKU",
  attributes = [],
}: {
  customerName?: string;
  status?: WorkflowStatus;
  priority?: number;
  quantity?: number;
  statusChangedAt?: Date;
  orderedAt?: Date;
  /** Adds a line for a non-physical product, like the store's Rush Order. */
  rushOrderLine?: boolean;
  /** The first line's SKU, e.g. one a test's priority rule matches. */
  sku?: string;
  /** The first line's size and checkout options, as sync stores them. */
  attributes?: { name: string; option: string }[];
} = {}) {
  const wooOrderId = nextWooId();
  const now = new Date();
  const rushOrder = rushOrderLine ? await rushOrderProduct() : null;
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
      orderedAt,
      wooModifiedAt: now,
      syncedAt: now,
      rawPayload: {},
      status,
      statusChangedAt,
      priority,
      items: {
        create: [
          {
            wooLineItemId: wooOrderId,
            sku,
            name: "E2E item",
            quantity,
            unitPriceCents: 500,
            attributes,
          },
          ...(rushOrder
            ? [
                {
                  wooLineItemId: wooOrderId + 1,
                  productId: rushOrder.id,
                  sku: rushOrder.sku,
                  name: rushOrder.name,
                  quantity: 1,
                  unitPriceCents: 1500,
                },
              ]
            : []),
        ],
      },
    },
  });
  created.push(order.id);
  return order;
}

/**
 * Changes an order the way time does (an SLA passing, a claim expiring): with no `order_changed`
 * notify, so only a refetch shows it.
 */
export async function changeOrderQuietly(id: string, data: { priority: number }) {
  await db.order.update({ where: { id }, data });
}

const RUSH_ORDER_WOO_ID = 999_999_999;

/** One shared non-physical product, kept between runs (orders using it are deleted, it isn't). */
async function rushOrderProduct() {
  const where = { wooProductId: RUSH_ORDER_WOO_ID };
  const product = { type: "simple", name: "E2E Rush Order", sku: "E2E-RUSH", physical: false };
  try {
    return await db.product.upsert({
      where,
      update: {},
      create: { ...where, ...product, rawPayload: {}, syncedAt: new Date() },
    });
  } catch {
    // Both projects' workers may create it at once: the loser reads the winner's row.
    return db.product.findUniqueOrThrow({ where });
  }
}

/**
 * Removes the orders this worker created (lines, events and packages cascade), so the dev stack's
 * queues keep showing the demo orders. Workers are separate processes, so another project's
 * orders are never touched while its tests still use them.
 */
export async function deleteCreatedOrders() {
  await db.order.deleteMany({ where: { id: { in: created.splice(0) } } });
}
