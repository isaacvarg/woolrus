import type {
  Db,
  LabelStatus,
  Order,
  OrderItem,
  Package,
  PickStatus,
  Prisma,
  WorkflowStatus,
} from "@woolrus/db";

/**
 * Builders for orders in any state, shared by workflow tests (and later picking/packing/qa).
 * Defaults describe a plain pending order; each option only overrides what a test cares about.
 */

export type LineSpec = {
  sku?: string;
  name?: string;
  quantity?: number;
  /** False for products never handled on the floor (Rush Order). */
  physical?: boolean;
  pickStatus?: PickStatus;
  /** Defaults to `quantity` when PICKED or SUBSTITUTED, else 0. */
  pickedQuantity?: number;
  voids?: { quantity: number; undone?: boolean }[];
  /** Line has no product row (deleted in Woo). */
  noProduct?: boolean;
};

export type PackageSpec = {
  /** Lines by index into `lines`. */
  items?: { line: number; quantity: number; verified?: boolean }[];
  /** False: no box and no override dimensions. */
  boxed?: boolean;
  /** Override dimensions instead of a box. */
  dimensions?: { lengthIn: number; widthIn: number; heightIn: number };
  weightOz?: number | null;
  rates?: { selected: boolean }[];
  label?: LabelStatus | null;
};

export type OrderSpec = Partial<
  Pick<
    Order,
    | "status"
    | "version"
    | "priority"
    | "number"
    | "customerName"
    | "shippingMethod"
    | "orderedAt"
    | "statusChangedAt"
    | "claimedById"
    | "claimedAt"
    | "holdReason"
    | "heldFromStatus"
  >
> & {
  lines?: LineSpec[];
  packages?: PackageSpec[];
};

export type BuiltOrder = { order: Order; items: OrderItem[]; packages: Package[] };

let seq = 0;
const next = () => {
  seq += 1;
  return (Date.now() % 1_000_000_000) + seq;
};

const address = {
  name: "Test Customer",
  address1: "1 Main St",
  city: "Austin",
  state: "TX",
  postalCode: "78701",
  country: "US",
};

export async function createOrder(db: Db, spec: OrderSpec = {}): Promise<BuiltOrder> {
  const { lines = [{}], packages: packageSpecs = [], ...fields } = spec;
  const id = next();
  const status: WorkflowStatus = fields.status ?? "PENDING";

  const order = await db.order.create({
    data: {
      wooOrderId: id,
      number: fields.number ?? String(id),
      wooStatus: "processing",
      currency: "USD",
      customerName: fields.customerName ?? "Test Customer",
      customerEmail: "customer@example.test",
      shippingAddress: address,
      billingAddress: address,
      totalCents: 2500,
      shippingMethod: fields.shippingMethod ?? "Flat rate",
      orderedAt: fields.orderedAt ?? new Date(),
      wooModifiedAt: new Date(),
      syncedAt: new Date(),
      rawPayload: {},
      status,
      statusChangedAt: fields.statusChangedAt ?? new Date(),
      priority: fields.priority ?? 0,
      version: fields.version ?? 1,
      claimedById: fields.claimedById ?? null,
      claimedAt: fields.claimedAt ?? (fields.claimedById ? new Date() : null),
      holdReason: fields.holdReason ?? null,
      heldFromStatus: fields.heldFromStatus ?? null,
      completedAt: status === "COMPLETED" ? new Date() : null,
    },
  });

  const items: OrderItem[] = [];
  for (const line of lines) items.push(await createLine(db, order.id, line));

  const packages: Package[] = [];
  for (const [index, pkg] of packageSpecs.entries()) {
    packages.push(await createPackage(db, order.id, index + 1, pkg, items));
  }

  return { order, items, packages };
}

async function createLine(db: Db, orderId: string, line: LineSpec): Promise<OrderItem> {
  const n = next();
  const quantity = line.quantity ?? 1;
  const name = line.name ?? `Product ${n}`;
  const sku = line.sku ?? `SKU-${n}`;
  const pickStatus = line.pickStatus ?? "PENDING";
  const picked = pickStatus === "PICKED" || pickStatus === "SUBSTITUTED";

  const product = line.noProduct
    ? null
    : await db.product.create({
        data: {
          wooProductId: n,
          type: "simple",
          name,
          sku,
          physical: line.physical ?? true,
          rawPayload: {},
          syncedAt: new Date(),
        },
      });

  const item = await db.orderItem.create({
    data: {
      orderId,
      wooLineItemId: n,
      productId: product?.id ?? null,
      name,
      sku,
      quantity,
      unitPriceCents: 1000,
      pickStatus,
      pickedQuantity: line.pickedQuantity ?? (picked ? quantity : 0),
      pickedAt: picked ? new Date() : null,
    },
  });

  for (const v of line.voids ?? []) {
    await db.itemVoid.create({
      data: {
        orderId,
        orderItemId: item.id,
        quantity: v.quantity,
        reason: "test void",
        stage: "PICKING",
        undoneAt: v.undone ? new Date() : null,
      },
    });
  }
  return item;
}

async function createPackage(
  db: Db,
  orderId: string,
  number: number,
  spec: PackageSpec,
  items: OrderItem[],
): Promise<Package> {
  const boxed = spec.boxed ?? !spec.dimensions;
  const box = boxed
    ? await db.box.create({
        data: { name: `Box ${next()}`, lengthIn: 10, widthIn: 8, heightIn: 4 },
      })
    : null;

  const pkg = await db.package.create({
    data: {
      orderId,
      number,
      boxId: box?.id ?? null,
      weightOz: spec.weightOz === undefined ? 16 : spec.weightOz,
      ...spec.dimensions,
    },
  });

  for (const it of spec.items ?? []) {
    const orderItem = items[it.line];
    if (!orderItem) throw new Error(`createOrder: package refers to missing line ${it.line}`);
    await db.packageItem.create({
      data: {
        packageId: pkg.id,
        orderItemId: orderItem.id,
        quantity: it.quantity,
        qaVerifiedAt: it.verified ? new Date() : null,
      },
    });
  }

  for (const rate of spec.rates ?? []) {
    const data: Prisma.ShippingRateUncheckedCreateInput = {
      packageId: pkg.id,
      shipstationRateId: `rate-${next()}`,
      carrierCode: "usps",
      serviceCode: "usps_ground_advantage",
      serviceName: "USPS Ground Advantage",
      amountCents: 650,
      currency: "USD",
      selected: rate.selected,
    };
    await db.shippingRate.create({ data });
  }

  if (spec.label) {
    await db.shippingLabel.create({
      data: {
        packageId: pkg.id,
        status: spec.label,
        idempotencyKey: `label-${next()}`,
        carrierCode: "usps",
        serviceCode: "usps_ground_advantage",
        currency: "USD",
      },
    });
  }
  return pkg;
}
