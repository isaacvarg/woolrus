import type {
  Db,
  FulfillmentStage,
  Prisma,
  QualityIssueSeverity,
  QualityIssueStatus,
  QualityIssueType,
  Role,
  ScanMissKind,
  ScanMissStage,
  VoidResolution,
  WorkflowStatus,
} from "../src/index";
import { upsertProducts } from "./seed-orders";

// Reporting dev data (SPEC-reporting "Dev data"): shipped orders spread over the last 30 days, with
// picks, packs, QA and shipments by named people, holds, a repack now and then, issues of every type,
// blocked scans of every kind and a few voids, so every report and the home tiles have something to
// show. The same generator, with more orders over more days, is the reports' speed check (#218).
// Never run in production: seed.ts skips this when NODE_ENV=production. Ids live in their own range
// (9,100,001+), and re-running skips the history once it exists.

const HISTORY_BASE = 9_100_000;
const MINUTE = 60_000;
const DAY = 86_400_000;

type Person = { key: string; name: string; email: string; roles: Role[] };

const people = {
  pickers: [
    { key: "picker", name: "Rita Picker", email: "demo-picker@example.test", roles: ["PICKER"] },
    {
      key: "picker2",
      name: "Pedro Picker",
      email: "demo-picker-2@example.test",
      roles: ["PICKER"],
    },
  ],
  packers: [
    { key: "packer", name: "Pablo Packer", email: "demo-packer@example.test", roles: ["PACKER"] },
    {
      key: "packer2",
      name: "Maria Packer",
      email: "demo-packer-2@example.test",
      roles: ["PACKER"],
    },
  ],
  qa: [{ key: "qa", name: "Quinn Checker", email: "demo-qa@example.test", roles: ["QA"] }],
  shippers: [
    { key: "shipper", name: "Sam Shipper", email: "demo-shipper@example.test", roles: ["SHIPPER"] },
  ],
} satisfies Record<string, Person[]>;

type Staff = { pickers: string[]; packers: string[]; qa: string[]; shippers: string[] };

async function upsertStaff(db: Db): Promise<Staff> {
  const ids = async (list: Person[]) => {
    const out: string[] = [];
    for (const { name, email, roles } of list) {
      const user = await db.user.upsert({
        where: { email },
        create: { name, email, roles },
        update: {},
      });
      out.push(user.id);
    }
    return out;
  };
  return {
    pickers: await ids(people.pickers),
    packers: await ids(people.packers),
    qa: await ids(people.qa),
    shippers: await ids(people.shippers),
  };
}

/** A small seeded PRNG (mulberry32), so the same call always seeds the same history. */
function random(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  /** Whole minutes in [min, max]. */
  const minutes = (min: number, max: number) =>
    (min + Math.floor(next() * (max - min + 1))) * MINUTE;
  return { next, minutes };
}

const firstNames = [
  "Alba",
  "Bruno",
  "Celia",
  "Dario",
  "Eva",
  "Fede",
  "Gala",
  "Iker",
  "Jana",
  "Leo",
];
const lastNames = ["Mora", "Paz", "Rey", "Sanz", "Toro", "Vidal", "Gómez", "Prieto", "Luna", "Cid"];

const skus = [
  "WOOL-MER-RED",
  "WOOL-MER-NAVY",
  "WOOL-ALP-CRM",
  "NDL-CIRC-5",
  "NDL-DPN-4",
  "KIT-BEANIE",
  "BOOK-WINTER",
  "SCARF-CA-NOHS",
];

// Each issue type with where it's usually found and where it came from (null: before the floor).
// biome-ignore format: one type per line reads as a table
const issueKinds: { type: QualityIssueType; found: FulfillmentStage; origin: "PICKING" | "PACKING" | "QA" | null; description: string }[] = [
  { type: "WRONG_ITEM", found: "PACKING", origin: "PICKING", description: "Navy picked instead of red" },
  { type: "WRONG_QUANTITY", found: "QA", origin: "PICKING", description: "One skein short in the tote" },
  { type: "MISSING_ITEM", found: "QA", origin: "PACKING", description: "Needles left out of the box" },
  { type: "PACKAGING_DAMAGE", found: "CUSTOMER", origin: "PACKING", description: "Box arrived crushed" },
  { type: "LABELING_ERROR", found: "SHIPPING", origin: "QA", description: "Label on the wrong box" },
  { type: "WRONG_BOX_SIZE", found: "QA", origin: "PACKING", description: "Mailer too small, items squashed" },
  { type: "DAMAGED_ITEM", found: "PICKING", origin: null, description: "Skein stained in the bin" },
  { type: "OTHER", found: "PACKING", origin: null, description: "Gift note missing" },
];
const severities: QualityIssueSeverity[] = ["MINOR", "MAJOR", "CRITICAL"];
const scanKinds: ScanMissKind[] = ["NOT_ON_ORDER", "UNKNOWN_CODE", "ALREADY_DONE", "OTHER_PACKAGE"];
const scanStages: ScanMissStage[] = ["PICKING", "PACKING", "QA"];
const voidResolutions: (VoidResolution | null)[] = ["REFUNDED", "HANDLED_MANUALLY", null];

type Rows = {
  orders: Prisma.OrderCreateManyInput[];
  items: Prisma.OrderItemCreateManyInput[];
  packages: Prisma.PackageCreateManyInput[];
  packageItems: Prisma.PackageItemCreateManyInput[];
  labels: Prisma.ShippingLabelCreateManyInput[];
  events: Prisma.OrderStageEventCreateManyInput[];
  audits: Prisma.AuditEventCreateManyInput[];
  issues: Prisma.QualityIssueCreateManyInput[];
  misses: Prisma.ScanMissCreateManyInput[];
  voids: Prisma.ItemVoidCreateManyInput[];
};

/** Inserts in chunks, so a 10,000-order history stays under Postgres' parameter limit. */
async function insert<T>(rows: T[], create: (data: T[]) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < rows.length; i += 2_000) await create(rows.slice(i, i + 2_000));
}

/**
 * Adds `orders` shipped orders spread evenly over the `days` up to `now` (a few shipped within the
 * last hours, so today has some), unless the history is already there. Returns how many it created.
 */
export async function seedReportingHistory(
  db: Db,
  {
    now = new Date(),
    orders = 150,
    days = 30,
  }: { now?: Date; orders?: number; days?: number } = {},
): Promise<number> {
  const existing = await db.order.count({
    where: { wooOrderId: { gt: HISTORY_BASE, lte: HISTORY_BASE + orders } },
  });
  if (existing > 0) return 0;

  const catalog = await upsertProducts(db);
  const barcodes = await db.product.findMany({
    where: { barcode: { not: null } },
    select: { barcode: true, name: true },
  });
  const box = await db.box.findFirst({ where: { archivedAt: null }, orderBy: { name: "asc" } });
  const staff = await upsertStaff(db);
  const rnd = random(218);
  const rows: Rows = {
    orders: [],
    items: [],
    packages: [],
    packageItems: [],
    labels: [],
    events: [],
    audits: [],
    issues: [],
    misses: [],
    voids: [],
  };

  for (let i = 0; i < orders; i += 1) {
    buildOrder(i, {
      rows,
      rnd,
      staff,
      catalog,
      barcodes,
      boxId: box?.id ?? null,
      now,
      orders,
      days,
    });
  }

  await db.$transaction(
    async (tx) => {
      await insert(rows.orders, (data) => tx.order.createMany({ data }));
      await insert(rows.items, (data) => tx.orderItem.createMany({ data }));
      await insert(rows.packages, (data) => tx.package.createMany({ data }));
      await insert(rows.packageItems, (data) => tx.packageItem.createMany({ data }));
      await insert(rows.labels, (data) => tx.shippingLabel.createMany({ data }));
      await insert(rows.events, (data) => tx.orderStageEvent.createMany({ data }));
      await insert(rows.audits, (data) => tx.auditEvent.createMany({ data }));
      await insert(rows.issues, (data) => tx.qualityIssue.createMany({ data }));
      await insert(rows.misses, (data) => tx.scanMiss.createMany({ data }));
      await insert(rows.voids, (data) => tx.itemVoid.createMany({ data }));
    },
    { timeout: 600_000, maxWait: 30_000 },
  );
  return orders;
}

type Build = {
  rows: Rows;
  rnd: ReturnType<typeof random>;
  staff: Staff;
  catalog: Map<string, { id: string; physical: boolean }>;
  barcodes: { barcode: string | null; name: string }[];
  boxId: string | null;
  now: Date;
  orders: number;
  days: number;
};

const pick = <T>(list: readonly T[], n: number): T => list[n % list.length] as T;

function buildOrder(i: number, b: Build): void {
  const { rows, rnd, staff, now } = b;
  const orderId = crypto.randomUUID();
  const picker = pick(staff.pickers, i);
  const packer = pick(staff.packers, Math.floor(i / 2));
  const qa = pick(staff.qa, i);
  // Now and then the carrier's tracking completes the order, not a person (SPEC-reporting: "System").
  const shipper = i % 17 === 0 ? null : pick(staff.shippers, i);

  // Oldest first; the last few ship within the last hours, so today has some.
  const daysAgo = b.days - 1 - Math.floor((i * b.days) / b.orders);
  const shippedAt = new Date(
    daysAgo === 0
      ? now.getTime() - rnd.minutes(10, 180)
      : now.getTime() - daysAgo * DAY - rnd.minutes(0, 8 * 60),
  );

  const held = i % 23 === 5;
  const repacked = i % 37 === 11;
  const idle = i % 9 === 1;
  const lineCount = 1 + (i % 3);
  const voided = i % 29 === 7;

  // How long each stay lasted, then the timeline walked forward from the import.
  const d = {
    pending: rnd.minutes(20, 14 * 60) + (i % 11 === 0 ? rnd.minutes(12 * 60, 30 * 60) : 0),
    hold: held ? rnd.minutes(60, 8 * 60) : 0,
    // Starting a pick claims the order, so this is the walk to the first bin, not waiting.
    pickWait: rnd.minutes(1, 5),
    pickWork: rnd.minutes(3, 20) + (idle ? 20 * MINUTE : 0),
    packWait: rnd.minutes(10, 150),
    packWork: rnd.minutes(4, 18),
    qaWait: rnd.minutes(5, 60),
    qaWork: rnd.minutes(2, 10),
    ready: rnd.minutes(20, 5 * 60),
    repack: repacked ? rnd.minutes(30, 90) : 0,
  };
  const total = Object.values(d).reduce((sum, ms) => sum + ms, 0);
  const importedAt = new Date(shippedAt.getTime() - total);
  let t = importedAt.getTime();
  const at = (ms = 0) => {
    t += ms;
    return new Date(t);
  };
  const events: {
    from: WorkflowStatus | null;
    to: WorkflowStatus;
    at: Date;
    actor: string | null;
  }[] = [];
  const move = (
    from: WorkflowStatus | null,
    to: WorkflowStatus,
    when: Date,
    actor: string | null,
  ) => events.push({ from, to, at: when, actor });
  const audit = (
    actorId: string | null,
    entityType: string,
    entityId: string,
    action: string,
    when: Date,
    change: { before?: Prisma.InputJsonObject; after?: Prisma.InputJsonObject } = {},
  ) => {
    rows.audits.push({ actorId, entityType, entityId, orderId, action, at: when, ...change });
    actions.push({ action, at: when });
  };
  /** This order's actions, for placing its blocked scan. */
  const actions: { action: string; at: Date }[] = [];

  move(null, "PENDING", at(), null);
  if (held) {
    move("PENDING", "ON_HOLD", at(Math.floor(d.pending / 2)), pick(staff.packers, i));
    move("ON_HOLD", "PENDING", at(d.hold), pick(staff.packers, i));
    at(d.pending - Math.floor(d.pending / 2));
  } else {
    at(d.pending);
  }

  // Lines: picked in Picking, the first one sometimes short a voided unit.
  const lines = Array.from({ length: lineCount }, (_, k) => {
    const sku = pick(skus, i * 3 + k * 5);
    const product = b.catalog.get(sku);
    if (!product) throw new Error(`Reporting history uses unknown SKU ${sku}`);
    const quantity = 1 + ((i + k * 2) % 4) + (voided && k === 0 ? 1 : 0);
    return {
      id: crypto.randomUUID(),
      sku,
      productId: product.id,
      quantity,
      active: quantity - (voided && k === 0 ? 1 : 0),
      pickedAt: new Date(0),
    };
  });

  // Picking: one pick per line (with a 20-minute pause on some orders).
  const pickStart = at();
  move("PENDING", "PICKING", pickStart, picker);
  at(d.pickWait);
  const pickStep = Math.floor((d.pickWork - (idle ? 20 * MINUTE : 0)) / (lineCount + 1));
  for (const [k, line] of lines.entries()) {
    line.pickedAt = at(k === 0 ? 0 : pickStep + (idle && k === 1 ? 20 * MINUTE : 0));
    audit(picker, "OrderItem", line.id, "pick.pickLine", line.pickedAt, {
      before: { pickedQuantity: 0 },
      after: { pickedQuantity: line.active },
    });
    if (voided && k === 0) {
      const resolution = pick(voidResolutions, Math.floor(i / 29));
      rows.voids.push({
        orderId,
        orderItemId: line.id,
        quantity: 1,
        reason: "Damaged skein",
        stage: "PICKING",
        voidedById: picker,
        voidedAt: line.pickedAt,
        ...(resolution ? { resolution, resolvedAt: shippedAt } : {}),
      });
    }
  }
  t = pickStart.getTime() + d.pickWait + d.pickWork;
  move("PICKING", "PACKING", at(), picker);

  // Packing (and, on a repack, packing again), then QA.
  let packageNumber = 0;
  const packAndCheck = (round: number): string => {
    const start = at();
    at(round === 1 ? d.packWait : Math.floor(d.repack / 3));
    packageNumber += 1;
    const packageId = crypto.randomUUID();
    rows.packages.push({
      id: packageId,
      orderId,
      number: packageNumber,
      boxId: b.boxId,
      weightOz: 18 + (i % 12),
      ...(b.boxId ? {} : { lengthIn: 10, widthIn: 8, heightIn: 4 }),
    });
    const packedAt = at();
    audit(packer, "Package", packageId, "package.add", packedAt, {
      after: { number: packageNumber },
    });
    const work = round === 1 ? d.packWork : Math.floor(d.repack / 3);
    audit(packer, "Package", packageId, "package.setWeight", new Date(t + Math.floor(work / 2)), {
      before: { weightOz: null },
      after: { weightOz: 18 + (i % 12) },
    });
    const boxed = lines.map((line) => ({
      id: crypto.randomUUID(),
      packageId,
      orderItemId: line.id,
      quantity: line.active,
    }));
    // Throughput credits packing from this row, as the app writes it on Pack remaining.
    audit(packer, "Package", packageId, "package.packRemaining", packedAt, {
      before: { number: packageNumber, items: [] },
      after: {
        number: packageNumber,
        items: boxed.map((item) => ({ orderItemId: item.orderItemId, quantity: item.quantity })),
      },
    });
    t = start.getTime() + (round === 1 ? d.packWait + d.packWork : 2 * Math.floor(d.repack / 3));
    move("PACKING", "QA", at(), packer);

    const qaStart = at();
    at(round === 1 ? d.qaWait : Math.floor(d.repack / 6));
    const step = Math.floor(
      (round === 1 ? d.qaWork : Math.floor(d.repack / 6)) / (boxed.length + 1),
    );
    for (const item of boxed) {
      const verifiedAt = at(step);
      rows.packageItems.push({
        ...item,
        packedById: packer,
        packedAt,
        qaVerifiedById: qa,
        qaVerifiedAt: verifiedAt,
        qaVerifiedQuantity: item.quantity,
      });
      audit(qa, "PackageItem", item.id, "packageItem.verify", verifiedAt, {
        before: { verifiedQuantity: 0, quantity: item.quantity },
        after: { verifiedQuantity: item.quantity, quantity: item.quantity },
      });
    }
    t = qaStart.getTime() + (round === 1 ? d.qaWait + d.qaWork : Math.floor(d.repack / 6) * 2);
    move("QA", "READY", at(), qa);
    return packageId;
  };

  let livePackage = packAndCheck(1);
  if (repacked) {
    // QA found the wrong item after the label: the box goes back to Packing and is redone.
    const back = at(Math.floor(d.ready / 2));
    move("READY", "PACKING", back, qa);
    rows.packages[rows.packages.length - 1] = {
      ...(rows.packages.at(-1) as Prisma.PackageCreateManyInput),
      discardedAt: back,
    };
    rows.issues.push({
      orderId,
      type: "WRONG_ITEM",
      severity: "MAJOR",
      status: "RESOLVED",
      description: "Wrong colour boxed; repacked",
      discoveredStage: "QA",
      originStage: "PACKING",
      reporterId: qa,
      responsibleUserId: packer,
      triggeredRepack: true,
      resolutionNotes: "Repacked with the right colour",
      resolvedById: qa,
      resolvedAt: shippedAt,
      createdAt: back,
    });
    livePackage = packAndCheck(2);
  }
  const readyAt = at();
  rows.labels.push({
    packageId: livePackage,
    status: "ACTIVE",
    provider: "SHIPSTATION",
    idempotencyKey: `demo-history-label-${i + 1}`,
    trackingNumber: `9400200000000000${String(i + 1).padStart(6, "0")}`,
    carrierCode: "usps",
    serviceCode: "usps_ground_advantage",
    costCents: 520 + (i % 9) * 35,
    currency: "USD",
    purchasedAt: new Date(readyAt.getTime() - MINUTE),
  });
  move("READY", "COMPLETED", shippedAt, shipper);

  // An issue on about one order in six, cycling through every type.
  if (i % 6 === 2) {
    const kind = pick(issueKinds, Math.floor(i / 6));
    const stayOf = (stage: FulfillmentStage) => {
      const status = stage === "SHIPPING" ? "READY" : stage;
      const into = events.find((e) => e.to === status);
      const out = into ? events[events.indexOf(into) + 1] : undefined;
      return into && out ? (into.at.getTime() + out.at.getTime()) / 2 : shippedAt.getTime();
    };
    const createdAt =
      kind.found === "CUSTOMER"
        ? new Date(Math.min(shippedAt.getTime() + 2 * DAY, now.getTime() - MINUTE))
        : new Date(stayOf(kind.found));
    const reporter =
      kind.found === "PICKING"
        ? picker
        : kind.found === "PACKING"
          ? packer
          : kind.found === "QA"
            ? qa
            : null;
    const responsible =
      kind.origin === "PICKING"
        ? picker
        : kind.origin === "PACKING"
          ? packer
          : kind.origin === "QA"
            ? qa
            : null;
    const status: QualityIssueStatus =
      i % 4 === 0 ? "OPEN" : i % 13 === 0 ? "DISMISSED" : "RESOLVED";
    const issueId = crypto.randomUUID();
    rows.issues.push({
      id: issueId,
      orderId,
      type: kind.type,
      severity: pick(severities, i),
      status,
      description: kind.description,
      discoveredStage: kind.found,
      originStage: kind.origin,
      customerReported: kind.found === "CUSTOMER",
      reporterId: reporter,
      responsibleUserId: responsible,
      resolutionNotes: status === "OPEN" ? null : "Handled with the customer",
      resolvedById: status === "OPEN" ? null : qa,
      resolvedAt:
        status === "OPEN" ? null : new Date(Math.min(createdAt.getTime() + DAY, now.getTime())),
      createdAt,
    });
    audit(reporter, "QualityIssue", issueId, "issue.report", createdAt, {
      after: { type: kind.type, severity: pick(severities, i) },
    });
  }

  // A blocked scan on about one order in five, cycling through every kind and stage.
  if (i % 5 === 3) {
    const n = Math.floor(i / 5);
    const kind = pick(scanKinds, n);
    const stage = pick(scanStages, Math.floor(n / 4));
    const actorId = stage === "PICKING" ? picker : stage === "PACKING" ? packer : qa;
    const product = pick(b.barcodes, n);
    const first = actions.find(
      (a) =>
        a.action ===
        (stage === "PICKING"
          ? "pick.pickLine"
          : stage === "PACKING"
            ? "package.add"
            : "packageItem.verify"),
    );
    rows.misses.push({
      orderId,
      stage,
      kind,
      code: kind === "UNKNOWN_CODE" ? "4006381333931" : (product?.barcode ?? "0700000000011"),
      productName: kind === "UNKNOWN_CODE" ? null : (product?.name ?? null),
      actorId,
      at: new Date((first?.at ?? shippedAt).getTime() + MINUTE),
    });
  }

  const customer = `${pick(firstNames, i)} ${pick(lastNames, Math.floor(i / 10))}`;
  const ship = {
    name: customer,
    address1: "742 Evergreen Terrace",
    city: "Austin",
    state: "TX",
    postalCode: "78701",
    country: "US",
  };
  rows.orders.push({
    id: orderId,
    wooOrderId: HISTORY_BASE + i + 1,
    number: String(70_001 + i),
    wooStatus: "completed",
    currency: "USD",
    customerName: customer,
    customerEmail: `history-${i + 1}@example.test`,
    shippingAddress: ship,
    billingAddress: ship,
    totalCents: lines.reduce((sum, l) => sum + l.quantity * 1800, 0),
    shippingMethod: "Flat rate",
    orderedAt: importedAt,
    wooModifiedAt: shippedAt,
    syncedAt: importedAt,
    rawPayload: { demo: true },
    status: "COMPLETED",
    statusChangedAt: shippedAt,
    completedAt: shippedAt,
  });
  for (const [k, line] of lines.entries()) {
    rows.items.push({
      id: line.id,
      orderId,
      wooLineItemId: (HISTORY_BASE + i + 1) * 10 + k,
      productId: line.productId,
      name: line.sku,
      sku: line.sku,
      quantity: line.quantity,
      unitPriceCents: 1800,
      pickStatus: "PICKED",
      pickedQuantity: line.active,
      pickedById: picker,
      pickedAt: line.pickedAt,
    });
  }
  for (const e of events) {
    rows.events.push({
      orderId,
      fromStatus: e.from,
      toStatus: e.to,
      actorId: e.actor,
      reason: e.to === "ON_HOLD" ? "Customer asked to add an item" : null,
      at: e.at,
    });
  }
}
