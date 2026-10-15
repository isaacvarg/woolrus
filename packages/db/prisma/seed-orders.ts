import type { Db, DbTx, PickStatus, Prisma, WorkflowStatus } from "../src/index";

// Demo orders for the dev stack (SPEC-workflow "Dev data"), so queues and order pages can be used
// before store-sync exists. Never run in production: seed.ts skips this when NODE_ENV=production.
// Ids live in a reserved range (9,000,000+) so they can't collide with real WooCommerce ids, and
// re-running skips orders that already exist instead of resetting what someone did to them.

const ID_BASE = 9_000_000;

type DemoProduct = { sku: string; name: string; bin: string; weightOz: number; physical?: boolean };

const products: DemoProduct[] = [
  { sku: "WOOL-MER-RED", name: "Merino yarn, Red", bin: "A-01-1", weightOz: 3.5 },
  { sku: "WOOL-MER-NAVY", name: "Merino yarn, Navy", bin: "A-01-2", weightOz: 3.5 },
  { sku: "WOOL-ALP-CRM", name: "Alpaca blend, Cream", bin: "A-02-1", weightOz: 3.5 },
  { sku: "NDL-CIRC-5", name: "Circular needles 5 mm", bin: "B-01-1", weightOz: 1.2 },
  { sku: "NDL-DPN-4", name: "Double-pointed needles 4 mm", bin: "B-01-2", weightOz: 0.8 },
  { sku: "KIT-BEANIE", name: "Beanie kit", bin: "C-03-1", weightOz: 9 },
  { sku: "BOOK-WINTER", name: "Pattern book: Winter Knits", bin: "D-01-1", weightOz: 14 },
  // Sold in the store but never handled on the floor: it only raises priority.
  { sku: "RUSH-ORDER", name: "Rush Order", bin: "", weightOz: 0, physical: false },
];

/** How far the floor got with an order's lines and packages, independent of its status. */
type Progress = "none" | "picked" | "packed" | "verified" | "labeled";

type DemoOrder = {
  customer: string;
  status: WorkflowStatus;
  /** Lines as [sku, quantity]. */
  lines: [string, number][];
  progress: Progress;
  ageHours: number;
  /** Minutes since the order entered its current status. */
  inStageMinutes: number;
  method?: string;
  /** ON_HOLD / CANCELLED: the stage it left, and why. */
  from?: WorkflowStatus;
  reason?: string;
  /** Void this many units of the first line. */
  voidFirst?: number;
};

// biome-ignore format: one order per line reads as a table
const orders: DemoOrder[] = [
  // Pending
  { customer: "Ana López", status: "PENDING", lines: [["WOOL-MER-RED", 4], ["RUSH-ORDER", 1]], progress: "none", ageHours: 1, inStageMinutes: 60 },
  { customer: "Bruno Díaz", status: "PENDING", lines: [["KIT-BEANIE", 1]], progress: "none", ageHours: 2, inStageMinutes: 120, method: "USPS Priority Mail Express" },
  { customer: "Carla Ruiz", status: "PENDING", lines: [["BOOK-WINTER", 1], ["NDL-CIRC-5", 2]], progress: "none", ageHours: 74, inStageMinutes: 74 * 60 },
  { customer: "Diego Fernández", status: "PENDING", lines: [["WOOL-ALP-CRM", 6]], progress: "none", ageHours: 5, inStageMinutes: 300 },
  { customer: "Elena Morales", status: "PENDING", lines: [["WOOL-MER-NAVY", 2], ["NDL-DPN-4", 1]], progress: "none", ageHours: 8, inStageMinutes: 480 },
  { customer: "Felipe Ortega", status: "PENDING", lines: [["KIT-BEANIE", 2], ["WOOL-MER-RED", 1]], progress: "none", ageHours: 0.5, inStageMinutes: 30 },
  { customer: "Grace Kim", status: "PENDING", lines: [["NDL-CIRC-5", 1]], progress: "none", ageHours: 20, inStageMinutes: 1200 },
  { customer: "Hugo Martín", status: "PENDING", lines: [["WOOL-MER-NAVY", 10]], progress: "none", ageHours: 3, inStageMinutes: 180 },
  // Picking: the first three are fully picked and can be completed.
  { customer: "Isabel Navarro", status: "PICKING", lines: [["WOOL-MER-RED", 2]], progress: "picked", ageHours: 6, inStageMinutes: 25 },
  { customer: "James Carter", status: "PICKING", lines: [["KIT-BEANIE", 1], ["RUSH-ORDER", 1]], progress: "picked", ageHours: 4, inStageMinutes: 15 },
  { customer: "Karla Vega", status: "PICKING", lines: [["BOOK-WINTER", 1]], progress: "picked", ageHours: 9, inStageMinutes: 40 },
  { customer: "Luis Herrera", status: "PICKING", lines: [["WOOL-ALP-CRM", 3], ["NDL-DPN-4", 1]], progress: "none", ageHours: 7, inStageMinutes: 95 },
  { customer: "María Castro", status: "PICKING", lines: [["NDL-CIRC-5", 2]], progress: "none", ageHours: 10, inStageMinutes: 10 },
  // Packing: two packed and ready for QA, two picked but not boxed (one with a voided unit).
  { customer: "Nora Jiménez", status: "PACKING", lines: [["WOOL-MER-NAVY", 3]], progress: "packed", ageHours: 12, inStageMinutes: 20 },
  { customer: "Óscar Ramos", status: "PACKING", lines: [["KIT-BEANIE", 1], ["NDL-CIRC-5", 1]], progress: "packed", ageHours: 11, inStageMinutes: 35, method: "UPS 2nd Day Air Express" },
  { customer: "Paula Gil", status: "PACKING", lines: [["WOOL-MER-RED", 3], ["BOOK-WINTER", 1]], progress: "picked", ageHours: 14, inStageMinutes: 50, voidFirst: 1 },
  { customer: "Quentin Moore", status: "PACKING", lines: [["WOOL-ALP-CRM", 2]], progress: "picked", ageHours: 15, inStageMinutes: 70 },
  // QA: two verified and labeled, two waiting for verification.
  { customer: "Rosa Delgado", status: "QA", lines: [["NDL-DPN-4", 2]], progress: "labeled", ageHours: 18, inStageMinutes: 15 },
  { customer: "Samuel Torres", status: "QA", lines: [["WOOL-MER-NAVY", 1], ["WOOL-MER-RED", 1]], progress: "labeled", ageHours: 19, inStageMinutes: 30 },
  { customer: "Teresa Flores", status: "QA", lines: [["KIT-BEANIE", 3]], progress: "packed", ageHours: 22, inStageMinutes: 45 },
  { customer: "Ulises Reyes", status: "QA", lines: [["BOOK-WINTER", 2]], progress: "packed", ageHours: 23, inStageMinutes: 90 },
  // Ready
  { customer: "Valeria Soto", status: "READY", lines: [["WOOL-ALP-CRM", 4]], progress: "labeled", ageHours: 26, inStageMinutes: 60 },
  { customer: "William Brooks", status: "READY", lines: [["NDL-CIRC-5", 1], ["RUSH-ORDER", 1]], progress: "labeled", ageHours: 5, inStageMinutes: 20 },
  { customer: "Ximena Cruz", status: "READY", lines: [["WOOL-MER-RED", 2]], progress: "labeled", ageHours: 30, inStageMinutes: 120 },
  // Completed
  { customer: "Yolanda Peña", status: "COMPLETED", lines: [["KIT-BEANIE", 1]], progress: "labeled", ageHours: 50, inStageMinutes: 24 * 60 },
  { customer: "Zoe Alvarez", status: "COMPLETED", lines: [["WOOL-MER-NAVY", 5]], progress: "labeled", ageHours: 60, inStageMinutes: 30 * 60 },
  { customer: "Adrián Silva", status: "COMPLETED", lines: [["BOOK-WINTER", 1], ["NDL-DPN-4", 1]], progress: "labeled", ageHours: 96, inStageMinutes: 72 * 60 },
  // On hold and cancelled
  { customer: "Beatriz Molina", status: "ON_HOLD", lines: [["WOOL-MER-RED", 2]], progress: "none", ageHours: 28, inStageMinutes: 200, from: "PENDING", reason: "Customer asked to change the shipping address" },
  { customer: "César Rojas", status: "ON_HOLD", lines: [["WOOL-ALP-CRM", 1], ["KIT-BEANIE", 1]], progress: "picked", ageHours: 34, inStageMinutes: 400, from: "PACKING", reason: "Beanie kit box damaged, waiting for a replacement" },
  { customer: "Daniela Vargas", status: "CANCELLED", lines: [["NDL-CIRC-5", 3]], progress: "none", ageHours: 40, inStageMinutes: 1000, from: "PENDING", reason: "Duplicate order" },
];

const flow: WorkflowStatus[] = ["PENDING", "PICKING", "PACKING", "QA", "READY", "COMPLETED"];

/** The statuses an order went through, in order, ending at its current one. */
function pathOf(order: DemoOrder): WorkflowStatus[] {
  if (order.status === "ON_HOLD" || order.status === "CANCELLED") {
    const from = order.from ?? "PENDING";
    return [...flow.slice(0, flow.indexOf(from) + 1), order.status];
  }
  return flow.slice(0, flow.indexOf(order.status) + 1);
}

/**
 * The rules that give the queues meaningful priority before store-sync exists. Conditions use the
 * shapes of contracts' `PriorityRuleCondition` (this package can't depend on contracts).
 */
const demoRules: { name: string; condition: Prisma.InputJsonObject; priority: number }[] = [
  {
    name: "Rush Order",
    condition: { type: "lineItem", match: "sku", value: "RUSH-ORDER" },
    priority: 2,
  },
  {
    name: "Express shipping",
    condition: { type: "shippingMethod", contains: "Express" },
    priority: 1,
  },
  { name: "Waiting 2+ days", condition: { type: "orderAge", minHours: 48 }, priority: 1 },
];

/** What `demoRules` compute, set inline so the orders are right without core's recompute. */
function priorityOf(order: DemoOrder): number {
  if (order.lines.some(([sku]) => sku === "RUSH-ORDER")) return 2;
  if (order.method?.toLowerCase().includes("express") || order.ageHours >= 48) return 1;
  return 0;
}

const address = (name: string): Prisma.InputJsonValue => ({
  name,
  address1: "742 Evergreen Terrace",
  city: "Austin",
  state: "TX",
  postalCode: "78701",
  country: "US",
});

async function upsertProducts(db: Db): Promise<Map<string, { id: string; physical: boolean }>> {
  const bySku = new Map<string, { id: string; physical: boolean }>();
  for (const [i, p] of products.entries()) {
    const physical = p.physical ?? true;
    const row = await db.product.upsert({
      where: { wooProductId: ID_BASE + i + 1 },
      create: {
        wooProductId: ID_BASE + i + 1,
        type: physical ? "simple" : "virtual",
        name: p.name,
        sku: p.sku,
        priceCents: physical ? 1800 : 1500,
        weightOz: p.weightOz,
        binLocation: p.bin || null,
        physical,
        rawPayload: { demo: true },
        syncedAt: new Date(),
      },
      update: {},
    });
    bySku.set(p.sku, { id: row.id, physical: row.physical });
  }
  return bySku;
}

async function createDemoOrder(
  tx: DbTx,
  index: number,
  spec: DemoOrder,
  catalog: Map<string, { id: string; physical: boolean }>,
  boxId: string | null,
  now: Date,
): Promise<void> {
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
  const orderedAt = hoursAgo(spec.ageHours);
  const enteredAt = new Date(now.getTime() - spec.inStageMinutes * 60_000);
  const path = pathOf(spec);
  const picked = spec.progress !== "none";

  const order = await tx.order.create({
    data: {
      wooOrderId: ID_BASE + index + 1,
      number: String(9001 + index),
      wooStatus:
        spec.status === "COMPLETED"
          ? "completed"
          : spec.status === "CANCELLED"
            ? "cancelled"
            : "processing",
      currency: "USD",
      customerName: spec.customer,
      customerEmail: `${spec.customer.split(" ")[0]?.toLowerCase()}@example.test`,
      shippingAddress: address(spec.customer),
      billingAddress: address(spec.customer),
      totalCents: spec.lines.reduce((sum, [, qty]) => sum + qty * 1800, 0),
      shippingMethod: spec.method ?? "Flat rate",
      orderedAt,
      wooModifiedAt: orderedAt,
      syncedAt: orderedAt,
      rawPayload: { demo: true },
      status: spec.status,
      statusChangedAt: enteredAt,
      priority: priorityOf(spec),
      holdReason: spec.status === "ON_HOLD" ? (spec.reason ?? null) : null,
      heldFromStatus: spec.status === "ON_HOLD" ? (spec.from ?? null) : null,
      completedAt: spec.status === "COMPLETED" ? enteredAt : null,
    },
  });

  const physicalLines: { id: string; active: number }[] = [];
  for (const [lineIndex, [sku, quantity]] of spec.lines.entries()) {
    const product = catalog.get(sku);
    if (!product) throw new Error(`Demo order uses unknown SKU ${sku}`);
    const voided = lineIndex === 0 ? (spec.voidFirst ?? 0) : 0;
    const active = quantity - voided;
    const pickStatus: PickStatus = picked && product.physical ? "PICKED" : "PENDING";
    const item = await tx.orderItem.create({
      data: {
        orderId: order.id,
        wooLineItemId: ID_BASE + (index + 1) * 100 + lineIndex,
        productId: product.id,
        name: products.find((p) => p.sku === sku)?.name ?? sku,
        sku,
        quantity,
        unitPriceCents: 1800,
        pickStatus,
        pickedQuantity: pickStatus === "PICKED" ? active : 0,
        pickedAt: pickStatus === "PICKED" ? enteredAt : null,
      },
    });
    if (voided > 0) {
      await tx.itemVoid.create({
        data: {
          orderId: order.id,
          orderItemId: item.id,
          quantity: voided,
          reason: "Damaged skein",
          stage: "PICKING",
          voidedAt: enteredAt,
        },
      });
    }
    if (product.physical) physicalLines.push({ id: item.id, active });
  }

  if (spec.progress === "packed" || spec.progress === "verified" || spec.progress === "labeled") {
    const verified = spec.progress !== "packed";
    const pkg = await tx.package.create({
      // Without a box (none seeded), the override dimensions satisfy the packed gate instead.
      data: {
        orderId: order.id,
        number: 1,
        boxId,
        weightOz: 24,
        ...(boxId ? {} : { lengthIn: 10, widthIn: 8, heightIn: 4 }),
      },
    });
    for (const line of physicalLines) {
      await tx.packageItem.create({
        data: {
          packageId: pkg.id,
          orderItemId: line.id,
          quantity: line.active,
          packedAt: enteredAt,
          qaVerifiedAt: verified ? enteredAt : null,
        },
      });
    }
    if (verified) {
      await tx.shippingRate.create({
        data: {
          packageId: pkg.id,
          shipstationRateId: `demo-rate-${index + 1}`,
          carrierCode: "usps",
          serviceCode: "usps_ground_advantage",
          serviceName: "USPS Ground Advantage",
          amountCents: 650,
          currency: "USD",
          selected: true,
        },
      });
    }
    if (spec.progress === "labeled") {
      await tx.shippingLabel.create({
        data: {
          packageId: pkg.id,
          status: "ACTIVE",
          idempotencyKey: `demo-label-${index + 1}`,
          trackingNumber: `9400100000000000${String(index + 1).padStart(6, "0")}`,
          carrierCode: "usps",
          serviceCode: "usps_ground_advantage",
          costCents: 650,
          currency: "USD",
          purchasedAt: enteredAt,
        },
      });
    }
  }

  // History: the import into Pending, then each move, spread evenly up to the current status.
  const steps = path.length;
  const span = enteredAt.getTime() - orderedAt.getTime();
  for (const [step, to] of path.entries()) {
    const at = step === 0 ? orderedAt : new Date(orderedAt.getTime() + (span * step) / (steps - 1));
    await tx.orderStageEvent.create({
      data: {
        orderId: order.id,
        fromStatus: step === 0 ? null : (path[step - 1] ?? null),
        toStatus: to,
        reason: step === steps - 1 && spec.reason ? spec.reason : null,
        at: step === steps - 1 ? enteredAt : at,
      },
    });
  }
}

/** Adds the demo rules whose name isn't taken yet, after any existing ones. */
async function seedDemoRules(db: Db): Promise<void> {
  for (const rule of demoRules) {
    if (await db.priorityRule.findFirst({ where: { name: rule.name } })) continue;
    const last = await db.priorityRule.aggregate({ _max: { position: true } });
    await db.priorityRule.create({ data: { ...rule, position: (last._max.position ?? -1) + 1 } });
  }
}

/** Adds the demo rules and orders that don't exist yet. Returns how many orders were created. */
export async function seedDemoOrders(db: Db, { now = new Date() }: { now?: Date } = {}) {
  await seedDemoRules(db);
  const catalog = await upsertProducts(db);
  const box = await db.box.findFirst({ where: { archivedAt: null }, orderBy: { name: "asc" } });

  let created = 0;
  for (const [index, spec] of orders.entries()) {
    const exists = await db.order.findUnique({ where: { wooOrderId: ID_BASE + index + 1 } });
    if (exists) continue;
    await db.$transaction((tx) => createDemoOrder(tx, index, spec, catalog, box?.id ?? null, now));
    created += 1;
  }
  return created;
}
