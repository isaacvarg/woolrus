import {
  type Db,
  type DbTx,
  type PickStatus,
  Prisma,
  type QualityIssueSeverity,
  type QualityIssueStatus,
  type QualityIssueType,
  type ShippingProviderId,
  type WorkflowStatus,
} from "../src/index";

// Demo orders for the dev stack (SPEC-workflow "Dev data"), so queues and order pages can be used
// before store-sync exists. Never run in production: seed.ts skips this when NODE_ENV=production.
// Ids live in a reserved range (9,000,000+) so they can't collide with real WooCommerce ids, and
// re-running skips orders that already exist instead of resetting what someone did to them.

const ID_BASE = 9_000_000;

type DemoProduct = {
  sku: string;
  name: string;
  bin: string;
  weightOz: number;
  /** Length, width, height in inches; none on one product, so the box suggestion shows "unknown". */
  dims?: [number, number, number];
  physical?: boolean;
  /** What a scanner reads off the label (FR-PICK-06); the rest match by SKU. */
  barcode?: string;
};

const products: DemoProduct[] = [
  {
    sku: "WOOL-MER-RED",
    name: "Merino yarn, Red",
    bin: "A-01-1",
    weightOz: 3.5,
    dims: [4, 4, 3],
    barcode: "0700000000011",
  },
  {
    sku: "WOOL-MER-NAVY",
    name: "Merino yarn, Navy",
    bin: "A-01-2",
    weightOz: 3.5,
    dims: [4, 4, 3],
    barcode: "0700000000028",
  },
  {
    sku: "WOOL-ALP-CRM",
    name: "Alpaca blend, Cream",
    bin: "A-02-1",
    weightOz: 3.5,
    dims: [5, 5, 3],
  },
  {
    sku: "NDL-CIRC-5",
    name: "Circular needles 5 mm",
    bin: "B-01-1",
    weightOz: 1.2,
    dims: [12, 1, 1],
    barcode: "0700000000035",
  },
  {
    sku: "NDL-DPN-4",
    name: "Double-pointed needles 4 mm",
    bin: "B-01-2",
    weightOz: 0.8,
    dims: [7, 1, 1],
  },
  {
    sku: "KIT-BEANIE",
    name: "Beanie kit",
    bin: "C-03-1",
    weightOz: 9,
    dims: [8, 6, 3],
    barcode: "0700000000042",
  },
  // No dimensions: a box can't be suggested for an order with it.
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
  /** Voids on lines by index (exceptions dev data); `resolved` marks one as handled. */
  voids?: { line: number; quantity: number; resolved?: boolean }[];
  /** Quality issues (exceptions dev data). */
  issues?: DemoIssue[];
  /** The street line, when not the default; one with "Street" gets corrected by the fake ShipStation. */
  street?: string;
};

type DemoIssue = {
  type: QualityIssueType;
  severity: QualityIssueSeverity;
  description: string;
  stage: "PICKING" | "PACKING" | "QA" | "SHIPPING" | "CUSTOMER";
  status?: QualityIssueStatus;
  customerReported?: boolean;
  /** An internal note on the issue. */
  note?: string;
  resolution?: string;
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
  // Packing: two packed and ready for QA, three picked but not boxed (one with a voided unit, one needing two boxes).
  { customer: "Nora Jiménez", status: "PACKING", lines: [["WOOL-MER-NAVY", 3]], progress: "packed", ageHours: 12, inStageMinutes: 20 },
  { customer: "Óscar Ramos", status: "PACKING", lines: [["KIT-BEANIE", 1], ["NDL-CIRC-5", 1]], progress: "packed", ageHours: 11, inStageMinutes: 35, method: "UPS 2nd Day Air Express" },
  { customer: "Paula Gil", status: "PACKING", lines: [["WOOL-MER-RED", 3], ["BOOK-WINTER", 1]], progress: "picked", ageHours: 14, inStageMinutes: 50, voidFirst: 1 },
  { customer: "Quentin Moore", status: "PACKING", lines: [["WOOL-ALP-CRM", 2]], progress: "picked", ageHours: 15, inStageMinutes: 70 },
  // Picked, not boxed: a line of 6 that needs two boxes.
  { customer: "Ricardo Núñez", status: "PACKING", lines: [["WOOL-ALP-CRM", 6], ["NDL-CIRC-5", 1]], progress: "picked", ageHours: 13, inStageMinutes: 60 },
  // QA: two verified and labeled, two waiting for verification.
  { customer: "Rosa Delgado", status: "QA", lines: [["NDL-DPN-4", 2]], progress: "labeled", ageHours: 18, inStageMinutes: 15 },
  { customer: "Samuel Torres", status: "QA", lines: [["WOOL-MER-NAVY", 1], ["WOOL-MER-RED", 1]], progress: "labeled", ageHours: 19, inStageMinutes: 30 },
  { customer: "Teresa Flores", status: "QA", lines: [["KIT-BEANIE", 3]], progress: "packed", ageHours: 22, inStageMinutes: 45, street: "15 Elm Street" },
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
  // Exceptions dev data: voids and issues (SPEC-exceptions "Dev data"). Paula Gil's order above is the
  // partial void (1 of 3, unresolved).
  { customer: "Fabiola Reyes", status: "PACKING", lines: [["WOOL-MER-RED", 2], ["NDL-CIRC-5", 1]], progress: "picked", ageHours: 16, inStageMinutes: 55, issues: [{ type: "DAMAGED_ITEM", severity: "CRITICAL", description: "Needles snapped in the bin", stage: "PACKING", note: "Photo taken, rest of the bin needs a check" }] },
  { customer: "Gonzalo Pardo", status: "PACKING", lines: [["WOOL-ALP-CRM", 2]], progress: "picked", ageHours: 21, inStageMinutes: 80, voids: [{ line: 0, quantity: 2 }] },
  { customer: "Hilda Cano", status: "COMPLETED", lines: [["KIT-BEANIE", 3]], progress: "labeled", ageHours: 120, inStageMinutes: 96 * 60, voids: [{ line: 0, quantity: 1, resolved: true }], issues: [{ type: "WRONG_ITEM", severity: "MAJOR", description: "Customer received a Navy beanie kit", stage: "CUSTOMER", customerReported: true }] },
  { customer: "Ignacio Lara", status: "COMPLETED", lines: [["BOOK-WINTER", 1]], progress: "labeled", ageHours: 130, inStageMinutes: 100 * 60, issues: [{ type: "LABELING_ERROR", severity: "MINOR", description: "Label printed upside down", stage: "SHIPPING", status: "RESOLVED", resolution: "Reprinted and re-taped" }] },
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

const address = (name: string, street = "742 Evergreen Terrace"): Prisma.InputJsonObject => ({
  name,
  address1: street,
  city: "Austin",
  state: "TX",
  postalCode: "78701",
  country: "US",
});

/** Stacks seeded before dimensions existed get them on the next seed. */
const dimensionColumns = (p: DemoProduct) =>
  p.dims ? { lengthIn: p.dims[0], widthIn: p.dims[1], heightIn: p.dims[2] } : {};

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
        ...dimensionColumns(p),
        binLocation: p.bin || null,
        physical,
        barcode: p.barcode ?? null,
        rawPayload: { demo: true },
        syncedAt: new Date(),
      },
      // Demo stacks seeded before barcodes existed get them on the next seed.
      update: { ...(p.barcode ? { barcode: p.barcode } : {}), ...dimensionColumns(p) },
    });
    bySku.set(p.sku, { id: row.id, physical: row.physical });
  }
  return bySku;
}

type DemoService = { carrierId: string; serviceId: string };

/** Both provider accounts, disabled, as Settings → Shipping would create them on first read. */
async function upsertProviderAccounts(db: Db): Promise<void> {
  for (const provider of ["SHIPSTATION", "BRIDGE_SOURCE"] as const) {
    await db.shippingProviderAccount.upsert({
      where: { provider },
      create: { provider },
      update: {},
    });
  }
}

type FakeService = {
  code: string;
  name: string;
  domestic: boolean;
  baseCents: number;
  perOzCents: number;
  days: number;
  guaranteed?: boolean;
};
type FakeCatalog = {
  provider: ShippingProviderId;
  providerData: Prisma.InputJsonObject;
  carriers: { externalId: string; code: string; name: string; services: FakeService[] }[];
};

// What core's fake providers (adapters/shipping/fake.ts) list and quote, for SHIPPING_PROVIDERS=fake.
// This package can't depend on core, so carriers/demo-shipping.test.ts holds these to the fakes.
// biome-ignore format: one service per line reads as a table
const fakeCatalogs: FakeCatalog[] = [
  {
    provider: "SHIPSTATION",
    providerData: {},
    carriers: [
      { externalId: "se-demo-ground", code: "demo_ground", name: "Demo Ground", services: [
        { code: "demo_ground", name: "Demo Ground", domestic: true, baseCents: 450, perOzCents: 12, days: 5 },
        { code: "demo_ground_saver", name: "Demo Ground Saver", domestic: true, baseCents: 395, perOzCents: 14, days: 7 },
      ] },
      { externalId: "se-demo-express", code: "demo_express", name: "Demo Express", services: [
        { code: "demo_express", name: "Demo Express", domestic: true, baseCents: 1250, perOzCents: 20, days: 2, guaranteed: true },
        { code: "demo_express_intl", name: "Demo Express International", domestic: false, baseCents: 3200, perOzCents: 40, days: 6 },
      ] },
    ],
  },
  {
    provider: "BRIDGE_SOURCE",
    providerData: { packageTypeCode: "CUSTOM" },
    carriers: [
      { externalId: "DEMOGND", code: "demo_ground", name: "Demo Ground", services: [
        { code: "GND", name: "Demo Ground", domestic: true, baseCents: 430, perOzCents: 13, days: 5 },
        { code: "GNDECO", name: "Demo Ground Economy", domestic: true, baseCents: 410, perOzCents: 13, days: 8 },
      ] },
      { externalId: "DEMOEXP", code: "demo_express", name: "Demo Express", services: [
        { code: "EXP", name: "Demo Express", domestic: true, baseCents: 1290, perOzCents: 18, days: 2, guaranteed: true },
        { code: "EXPINTL", name: "Demo Express International", domestic: false, baseCents: 3050, perOzCents: 42, days: 6 },
      ] },
    ],
  },
];

type FakeServiceRow = DemoService & {
  provider: ShippingProviderId;
  carrierExternalId: string;
  carrierCode: string;
  service: FakeService;
};

/**
 * The fakes' carriers and services as a sync stores them, with the domestic ones on. Re-running
 * keeps whatever was switched since.
 */
async function upsertFakeCatalogs(db: Db): Promise<FakeServiceRow[]> {
  const rows: FakeServiceRow[] = [];
  for (const { provider, providerData, carriers } of fakeCatalogs) {
    for (const { externalId, code, name, services } of carriers) {
      const carrier = await db.shippingCarrier.upsert({
        where: { provider_externalId: { provider, externalId } },
        create: { provider, externalId, code, name, enabled: true },
        // Demo stacks seeded when the code was the external id get the carrier's code.
        update: { code },
      });
      for (const service of services) {
        const row = await db.carrierService.upsert({
          where: { carrierId_code: { carrierId: carrier.id, code: service.code } },
          create: {
            carrierId: carrier.id,
            code: service.code,
            name: service.name,
            domestic: service.domestic,
            international: !service.domestic,
            enabled: service.domestic,
            providerData,
          },
          update: {},
        });
        if (service.domestic) {
          rows.push({
            provider,
            carrierExternalId: externalId,
            carrierCode: carrier.code,
            carrierId: carrier.id,
            serviceId: row.id,
            service,
          });
        }
      }
    }
  }
  return rows;
}

/** A demo ship-from, so Refresh rates works once a fake provider is turned on. */
const demoShipFrom = {
  name: "Woolrus Warehouse",
  phone: "512-555-0100",
  address1: "100 Dock Rd",
  city: "Austin",
  state: "TX",
  postalCode: "78702",
  country: "US",
};

/** How long a rate without its own expiry is good for (core's RATE_TTL_HOURS). */
const RATE_TTL_HOURS = 24;
const providerOrder: ShippingProviderId[] = ["SHIPSTATION", "BRIDGE_SOURCE"];

/** What each fake quotes for a package of `weightOz`, cheapest first, as core's rate fetch stores it. */
function fakeRates(services: FakeServiceRow[], weightOz: number, shipmentId: string, now: Date) {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return services
    .map(({ provider, carrierExternalId, carrierCode, carrierId, serviceId, service }) => {
      const amountCents = service.baseCents + service.perOzCents * Math.ceil(weightOz);
      // ShipStation quotes with a rate id and a delivery estimate; Bridge Source with neither.
      const shipStation = provider === "SHIPSTATION";
      return {
        provider,
        carrierId,
        serviceId,
        providerRateId: shipStation
          ? `se-rate:${carrierExternalId}:${service.code}:${amountCents}`
          : null,
        providerShipmentId: shipStation ? shipmentId : null,
        carrierCode,
        serviceCode: service.code,
        serviceName: service.name,
        amountCents,
        currency: "USD",
        deliveryDays: shipStation ? service.days : null,
        estimatedDeliveryAt: shipStation
          ? new Date(day.getTime() + service.days * 86_400_000)
          : null,
        guaranteed: service.guaranteed ?? false,
        trackable: true,
        fetchedAt: now,
        expiresAt: new Date(now.getTime() + RATE_TTL_HOURS * 3_600_000),
      };
    })
    .sort(
      (a, b) =>
        a.amountCents - b.amountCents ||
        (a.deliveryDays ?? Number.POSITIVE_INFINITY) -
          (b.deliveryDays ?? Number.POSITIVE_INFINITY) ||
        providerOrder.indexOf(a.provider) - providerOrder.indexOf(b.provider) ||
        a.serviceName.localeCompare(b.serviceName),
    )
    .map((rate, i) => ({ ...rate, selected: i === 0 }));
}

/** What the fake ShipStation's address check answers: any "Street" becomes "St". */
function fakeShipTo(original: Prisma.InputJsonObject, now: Date) {
  const street = String(original.address1);
  const fixed = street.replace(/\bStreet\b/g, "St");
  const corrected = fixed !== street;
  return {
    shipTo: corrected ? { ...original, address1: fixed } : original,
    shipToOriginal: original,
    shipToStatus: corrected ? ("CORRECTED" as const) : ("VERIFIED" as const),
    shipToMessages: corrected ? ["Street abbreviated."] : [],
    shipToCheckedAt: now,
  };
}

/**
 * How demo packages past Packing get their rates: from both fakes (SHIPPING_PROVIDERS=fake), or
 * one placeholder USPS rate on verified packages otherwise.
 */
type DemoShipping = { fake: FakeServiceRow[] } | { placeholder: DemoService };

/** The carrier and service the placeholder demo rates point at, without the fake providers. */
async function upsertDemoService(db: Db): Promise<DemoService> {
  const carrier = await db.shippingCarrier.upsert({
    where: { provider_externalId: { provider: "SHIPSTATION", externalId: "demo-usps" } },
    create: {
      provider: "SHIPSTATION",
      externalId: "demo-usps",
      code: "usps",
      name: "USPS",
      enabled: true,
    },
    update: {},
  });
  const service = await db.carrierService.upsert({
    where: { carrierId_code: { carrierId: carrier.id, code: "usps_ground_advantage" } },
    create: {
      carrierId: carrier.id,
      code: "usps_ground_advantage",
      name: "USPS Ground Advantage",
      domestic: true,
      international: false,
      enabled: true,
    },
    update: {},
  });
  return { carrierId: carrier.id, serviceId: service.id };
}

async function createDemoOrder(
  tx: DbTx,
  index: number,
  spec: DemoOrder,
  catalog: Map<string, { id: string; physical: boolean }>,
  boxId: string | null,
  shipping: DemoShipping,
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
      shippingAddress: address(spec.customer, spec.street),
      billingAddress: address(spec.customer, spec.street),
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
    const voided =
      (lineIndex === 0 ? (spec.voidFirst ?? 0) : 0) +
      (spec.voids ?? []).filter((v) => v.line === lineIndex).reduce((n, v) => n + v.quantity, 0);
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
    for (const v of spec.voids?.filter((x) => x.line === lineIndex) ?? []) {
      await tx.itemVoid.create({
        data: {
          orderId: order.id,
          orderItemId: item.id,
          quantity: v.quantity,
          reason: "Out of stock",
          stage: "PICKING",
          voidedAt: enteredAt,
          ...(v.resolved
            ? {
                resolution: "REFUNDED" as const,
                resolutionNotes: "Refunded in WooCommerce",
                resolvedAt: now,
              }
            : {}),
        },
      });
    }
    if (product.physical) physicalLines.push({ id: item.id, active });
  }

  for (const issue of spec.issues ?? []) {
    const resolved = (issue.status ?? "OPEN") !== "OPEN";
    const row = await tx.qualityIssue.create({
      data: {
        orderId: order.id,
        type: issue.type,
        severity: issue.severity,
        description: issue.description,
        discoveredStage: issue.stage,
        customerReported: issue.customerReported ?? false,
        status: issue.status ?? "OPEN",
        resolutionNotes: resolved ? (issue.resolution ?? null) : null,
        resolvedAt: resolved ? now : null,
        createdAt: enteredAt,
      },
    });
    if (issue.note) {
      await tx.note.create({
        data: { orderId: order.id, qualityIssueId: row.id, content: issue.note },
      });
    }
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
    // Packing → QA fetched rates for every package that got that far.
    const rated = "fake" in shipping && ["QA", "READY", "COMPLETED"].includes(spec.status);
    let bought = {
      provider: "SHIPSTATION" as ShippingProviderId,
      carrierCode: "usps",
      serviceCode: "usps_ground_advantage",
      costCents: 650,
    };
    if (rated && "fake" in shipping) {
      const rates = fakeRates(shipping.fake, 24, `se-shp-demo-${index + 1}`, now);
      await tx.shippingRate.createMany({ data: rates.map((r) => ({ ...r, packageId: pkg.id })) });
      await tx.package.update({
        where: { id: pkg.id },
        data: { ratesStatus: "READY", ratesFetchedAt: now },
      });
      const [cheapest] = rates;
      if (cheapest) bought = { ...cheapest, costCents: cheapest.amountCents };
      await tx.order.update({
        where: { id: order.id },
        data: fakeShipTo(address(spec.customer, spec.street), now),
      });
    } else if (verified && "placeholder" in shipping) {
      await tx.shippingRate.create({
        data: {
          packageId: pkg.id,
          provider: "SHIPSTATION",
          ...shipping.placeholder,
          providerRateId: `demo-rate-${index + 1}`,
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
          provider: bought.provider,
          idempotencyKey: `demo-label-${index + 1}`,
          trackingNumber: `9400100000000000${String(index + 1).padStart(6, "0")}`,
          carrierCode: bought.carrierCode,
          serviceCode: bought.serviceCode,
          costCents: bought.costCents,
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

/**
 * Adds the demo rules and orders that don't exist yet, and both shipping provider accounts
 * (disabled). With `fakeShipping` (SHIPPING_PROVIDERS=fake) the orders past Packing carry rates
 * from both fake providers (SPEC-carriers "Dev data"). Returns how many orders were created.
 */
export async function seedDemoOrders(
  db: Db,
  { now = new Date(), fakeShipping = false }: { now?: Date; fakeShipping?: boolean } = {},
) {
  await seedDemoRules(db);
  await upsertProviderAccounts(db);
  const catalog = await upsertProducts(db);
  const box = await db.box.findFirst({ where: { archivedAt: null }, orderBy: { name: "asc" } });
  let shipping: DemoShipping;
  if (fakeShipping) {
    shipping = { fake: await upsertFakeCatalogs(db) };
    await db.settings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
    await db.settings.updateMany({
      where: { shipFromAddress: { equals: Prisma.DbNull } },
      data: { shipFromAddress: demoShipFrom },
    });
  } else {
    shipping = { placeholder: await upsertDemoService(db) };
  }

  let created = 0;
  for (const [index, spec] of orders.entries()) {
    const exists = await db.order.findUnique({ where: { wooOrderId: ID_BASE + index + 1 } });
    if (exists) continue;
    await db.$transaction((tx) =>
      createDemoOrder(tx, index, spec, catalog, box?.id ?? null, shipping, now),
    );
    created += 1;
  }
  return created;
}
