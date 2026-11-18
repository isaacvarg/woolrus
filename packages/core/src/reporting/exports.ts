import {
  IssuesExportInput,
  OrderItemsExportInput,
  OrdersExportInput,
  VoidsExportInput,
} from "@woolrus/contracts";
import { type DbTx, Prisma } from "@woolrus/db";
import { type Locale, messages } from "@woolrus/i18n";
import { createLogger } from "@woolrus/logger";
import type { z } from "zod";
import type { CsvCell } from "../csv";
import { AppError } from "../errors";
import { issueListRank, issueListWhere } from "../exceptions/issues-queries";
import { searchFilter } from "../exceptions/search";
import { voidListFilter } from "../exceptions/voids-queries";
import { type Actor, assertCan } from "../permissions";
import type { CsvExport } from "../rate-lab/exports";
import { liveLabelStatuses } from "../workflow/gates";
import { orderListOrderBy, orderListWhere } from "../workflow/queries";

// CSV exports of the All orders, Issues and Voids lists, and of order lines (SPEC-reporting "CSV
// exports", FR-REP-04). Each takes its screen's filters, so the file holds the rows shown. Shared
// rules: `report.read`; no customer address, email or phone; times ISO 8601 in the requested zone;
// headers in the viewer's locale; at most EXPORT_ROW_CAP rows, then a row saying the file was cut.

const log = createLogger({ module: "reporting-exports" });

export const EXPORT_ROW_CAP = 100_000;

/** Rows load this many at a time while the file streams. */
const BATCH = 1000;

export type ExportOptions = {
  locale: Locale;
  now?: Date;
  /** Tests lower it; everything else uses EXPORT_ROW_CAP. */
  cap?: number;
};

/** An export's input: its contract's fields, parsed here, so a route can pass query parameters as they come. */
export type QueryOf<S extends z.ZodType> = { [K in keyof z.input<S>]?: unknown };

type Column = keyof (typeof messages)["en"]["exports"]["columns"];

/** `at` as ISO 8601 in `timeZone`, with its offset there: 2026-11-03T12:00:00-06:00. */
export function isoInZone(at: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const wall = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
  const offset = Math.round(
    (Date.parse(`${wall}Z`) - Math.floor(at.getTime() / 1000) * 1000) / 60_000,
  );
  const abs = Math.abs(offset);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${wall}${offset < 0 ? "-" : "+"}${pad(Math.trunc(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * At most `cap` rows of `rows`; when there are more, a last row `cut` instead of the rest, and
 * `onCut` is called once.
 */
export async function* capRows(
  rows: AsyncIterable<readonly CsvCell[]>,
  cap: number,
  cut: readonly CsvCell[],
  onCut: () => void,
): AsyncGenerator<readonly CsvCell[]> {
  let count = 0;
  for await (const row of rows) {
    if (count === cap) {
      onCut();
      yield cut;
      return;
    }
    count += 1;
    yield row;
  }
}

/** The pieces every export shares: header, time format, the cap and the file name's date. */
export function exportKit(
  name: string,
  timeZone: string,
  { locale, now = new Date(), cap }: ExportOptions,
) {
  const catalog = messages[locale].exports;
  const max = cap ?? EXPORT_ROW_CAP;
  const time = (at: Date | null) => (at ? isoInZone(at, timeZone) : null);
  return {
    max,
    time,
    yesNo: (value: boolean) => (value ? catalog.yes : catalog.no),
    header: (columns: readonly Column[]) => columns.map((c) => catalog.columns[c]),
    today: time(now)?.slice(0, 10) ?? "",
    capped(rows: AsyncIterable<readonly CsvCell[]>) {
      const cut = [catalog.cut.replace("{max}", new Intl.NumberFormat(locale).format(max))];
      return capRows(rows, max, cut, () =>
        log.warn({ export: name, cap: max }, "csv export cut at the row cap"),
      );
    },
  };
}

export function parseExport<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new AppError("BAD_REQUEST", "errors.validation");
  return parsed.data;
}

/** Loads `ids` in batches with `load`, yielding rows in `ids` order. */
async function* inBatches<T extends { id: string }>(
  ids: readonly string[],
  load: (batch: string[]) => Promise<T[]>,
  toRow: (row: T) => readonly CsvCell[],
): AsyncGenerator<readonly CsvCell[]> {
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const byId = new Map((await load(batch)).map((r) => [r.id, r]));
    for (const id of batch) {
      const row = byId.get(id);
      if (row) yield toRow(row);
    }
  }
}

const personName = (user: { name: string } | null | undefined) => user?.name.trim() || null;

/** A purged order exports its number and an empty customer name. */
const customerSql = Prisma.sql`CASE WHEN o.pii_redacted_at IS NULL THEN o.customer_name ELSE '' END`;

// ─── All orders ───────────────────────────────────────────────────────────────────────────────

const ORDER_COLUMNS = [
  "order",
  "ordered",
  "imported",
  "status",
  "priority",
  "customer",
  "items",
  "units",
  "shippedAt",
  "tracking",
] as const satisfies readonly Column[];

type OrderExportRow = {
  id: string;
  number: string;
  customerName: string;
  orderedAt: Date;
  importedAt: Date;
  status: string;
  priority: number;
  items: number;
  units: number;
  completedAt: Date | null;
  tracking: string | null;
};

/** The All orders list with its filters and sort, every page; `report.read`. */
export async function ordersCsv(
  db: DbTx,
  actor: Actor,
  input: QueryOf<typeof OrdersExportInput>,
  options: ExportOptions,
): Promise<CsvExport> {
  assertCan(actor, "report.read");
  const { search, statuses, sort, dir, timeZone } = parseExport(OrdersExportInput, input);
  const kit = exportKit("orders", timeZone, options);
  const ids = await db.$queryRaw<{ id: string }[]>`
    SELECT o.id FROM orders o ${orderListWhere({ search, statuses })}
    ORDER BY ${orderListOrderBy(sort, dir)}, o.id ASC
    LIMIT ${kit.max + 1}`;

  const load = (batch: string[]) => db.$queryRaw<OrderExportRow[]>`
    SELECT o.id, o.number, ${customerSql} AS "customerName", o.ordered_at AS "orderedAt",
      o.created_at AS "importedAt", o.status::text AS status, o.priority, o.completed_at AS "completedAt",
      COALESCE(lines.items, 0)::int AS items, COALESCE(lines.units, 0)::int AS units,
      (SELECT string_agg(l.tracking_number, ' ' ORDER BY pk.number, l.id)
        FROM packages pk JOIN shipping_labels l ON l.package_id = pk.id
        WHERE pk.order_id = o.id AND pk.discarded_at IS NULL AND l.tracking_number IS NOT NULL
          AND l.status::text = ANY(${[...liveLabelStatuses]})) AS tracking
    FROM orders o
    LEFT JOIN LATERAL (
      -- Physical lines and their active units, as the queues count them.
      SELECT COUNT(*) AS items, SUM(GREATEST(i.quantity - COALESCE((
          SELECT SUM(v.quantity) FROM item_voids v
          WHERE v.order_item_id = i.id AND v.undone_at IS NULL
        ), 0), 0)) AS units
      FROM order_items i LEFT JOIN products p ON p.id = i.product_id
      WHERE i.order_id = o.id AND COALESCE(p.physical, true)
    ) lines ON TRUE
    WHERE o.id = ANY(${batch}::uuid[])`;

  const rows = inBatches(
    ids.map((r) => r.id),
    load,
    (o) => [
      o.number,
      kit.time(o.orderedAt),
      kit.time(o.importedAt),
      o.status,
      o.priority,
      o.customerName,
      o.items,
      o.units,
      kit.time(o.completedAt),
      o.tracking,
    ],
  );
  return {
    filename: `woolrus-orders-${kit.today}.csv`,
    header: kit.header(ORDER_COLUMNS),
    rows: kit.capped(rows),
  };
}

// ─── Issues ───────────────────────────────────────────────────────────────────────────────────

const ISSUE_COLUMNS = [
  "order",
  "customer",
  "created",
  "type",
  "severity",
  "status",
  "discoveredStage",
  "originStage",
  "responsible",
  "reportedBy",
  "customerReported",
  "description",
  "resolvedAt",
  "resolvedBy",
] as const satisfies readonly Column[];

const nameOnly = { select: { name: true } } as const;

/** The Issues list with its filters, in its order, every page; `report.read`. */
export async function issuesCsv(
  db: DbTx,
  actor: Actor,
  input: QueryOf<typeof IssuesExportInput>,
  options: ExportOptions,
): Promise<CsvExport> {
  assertCan(actor, "report.read");
  const { timeZone, ...filters } = parseExport(IssuesExportInput, input);
  const kit = exportKit("issues", timeZone, options);
  const ids = await db.$queryRaw<{ id: string }[]>`
    SELECT i.id FROM quality_issues i JOIN orders o ON o.id = i.order_id
    ${issueListWhere(filters)}
    ORDER BY ${issueListRank} ASC, i.created_at DESC, i.id DESC
    LIMIT ${kit.max + 1}`;

  const load = (batch: string[]) =>
    db.qualityIssue.findMany({
      where: { id: { in: batch } },
      include: {
        order: { select: { number: true, customerName: true, piiRedactedAt: true } },
        responsibleUser: nameOnly,
        reporter: nameOnly,
        resolvedBy: nameOnly,
      },
    });
  const rows = inBatches(
    ids.map((r) => r.id),
    load,
    (i) => [
      i.order.number,
      i.order.piiRedactedAt ? "" : i.order.customerName,
      kit.time(i.createdAt),
      i.type,
      i.severity,
      i.status,
      i.discoveredStage,
      i.originStage,
      personName(i.responsibleUser),
      personName(i.reporter),
      kit.yesNo(i.customerReported),
      i.description,
      kit.time(i.resolvedAt),
      personName(i.resolvedBy),
    ],
  );
  return {
    filename: `woolrus-issues-${kit.today}.csv`,
    header: kit.header(ISSUE_COLUMNS),
    rows: kit.capped(rows),
  };
}

// ─── Voids ────────────────────────────────────────────────────────────────────────────────────

const VOID_COLUMNS = [
  "order",
  "customer",
  "orderStatus",
  "voidedAt",
  "sku",
  "product",
  "quantity",
  "reason",
  "stage",
  "voidedBy",
  "resolution",
  "resolvedAt",
  "resolvedBy",
  "undoneAt",
] as const satisfies readonly Column[];

/**
 * One row per void the Voids list shows on this tab and search, in its order (orders by their
 * newest matching void, then each order's voids newest first); `report.read`.
 */
export async function voidsCsv(
  db: DbTx,
  actor: Actor,
  input: QueryOf<typeof VoidsExportInput>,
  options: ExportOptions,
): Promise<CsvExport> {
  assertCan(actor, "report.read");
  const { status, search, timeZone } = parseExport(VoidsExportInput, input);
  const kit = exportKit("voids", timeZone, options);
  const at = status === "resolved" ? Prisma.sql`v.resolved_at` : Prisma.sql`v.voided_at`;
  const ids = await db.$queryRaw<{ id: string }[]>`
    SELECT v.id FROM item_voids v JOIN orders o ON o.id = v.order_id
    WHERE ${voidListFilter(status)} ${searchFilter(search)}
    ORDER BY MAX(${at}) OVER (PARTITION BY v.order_id) DESC, v.order_id DESC, ${at} DESC, v.id DESC
    LIMIT ${kit.max + 1}`;

  const load = (batch: string[]) =>
    db.itemVoid.findMany({
      where: { id: { in: batch } },
      include: {
        order: { select: { number: true, customerName: true, piiRedactedAt: true, status: true } },
        orderItem: { select: { sku: true, name: true } },
        voidedBy: nameOnly,
        resolvedBy: nameOnly,
      },
    });
  const rows = inBatches(
    ids.map((r) => r.id),
    load,
    (v) => [
      v.order.number,
      v.order.piiRedactedAt ? "" : v.order.customerName,
      v.order.status,
      kit.time(v.voidedAt),
      v.orderItem.sku,
      v.orderItem.name,
      v.quantity,
      v.reason,
      v.stage,
      personName(v.voidedBy),
      v.resolution,
      kit.time(v.resolvedAt),
      personName(v.resolvedBy),
      kit.time(v.undoneAt),
    ],
  );
  return {
    filename: `woolrus-voids-${kit.today}.csv`,
    header: kit.header(VOID_COLUMNS),
    rows: kit.capped(rows),
  };
}

// ─── Order items ──────────────────────────────────────────────────────────────────────────────

const ORDER_ITEM_COLUMNS = [
  "order",
  "sku",
  "product",
  "orderedQty",
  "pickedQty",
  "pickStatus",
  "pickedBy",
  "pickedAt",
  "packedBy",
  "packedAt",
  "qaBy",
  "qaAt",
  "voidedQty",
] as const satisfies readonly Column[];

type OrderItemExportRow = {
  id: string;
  number: string;
  sku: string | null;
  name: string;
  quantity: number;
  pickedQuantity: number;
  pickStatus: string;
  pickedBy: string | null;
  pickedAt: Date | null;
  packedBy: string | null;
  packedAt: Date | null;
  qaBy: string | null;
  qaAt: Date | null;
  voided: number;
};

/**
 * One row per order line on orders imported `from` through `to` in the zone, oldest order first;
 * `report.read`. Packed and QA'd by/at are the line's latest in a package that wasn't discarded.
 */
export async function orderItemsCsv(
  db: DbTx,
  actor: Actor,
  input: QueryOf<typeof OrderItemsExportInput>,
  options: ExportOptions,
): Promise<CsvExport> {
  assertCan(actor, "report.read");
  const { from, to, timeZone } = parseExport(OrderItemsExportInput, input);
  const kit = exportKit("order-items", timeZone, options);
  const day = Prisma.sql`(o.created_at AT TIME ZONE ${timeZone})::date`;
  const ids = await db.$queryRaw<{ id: string }[]>`
    SELECT i.id FROM order_items i JOIN orders o ON o.id = i.order_id
    WHERE ${day} BETWEEN ${from}::date AND ${to}::date
    ORDER BY o.created_at ASC, o.id ASC, i.id ASC
    LIMIT ${kit.max + 1}`;

  const load = (batch: string[]) => db.$queryRaw<OrderItemExportRow[]>`
    SELECT i.id, o.number, i.sku, i.name, i.quantity, i.picked_quantity AS "pickedQuantity",
      i.pick_status::text AS "pickStatus", picker.name AS "pickedBy", i.picked_at AS "pickedAt",
      packed.name AS "packedBy", packed.at AS "packedAt", qa.name AS "qaBy", qa.at AS "qaAt",
      COALESCE((SELECT SUM(v.quantity) FROM item_voids v
        WHERE v.order_item_id = i.id AND v.undone_at IS NULL), 0)::int AS voided
    FROM order_items i
    JOIN orders o ON o.id = i.order_id
    LEFT JOIN users picker ON picker.id = i.picked_by_id
    LEFT JOIN LATERAL (
      SELECT u.name, pi.packed_at AS at FROM package_items pi
      JOIN packages pk ON pk.id = pi.package_id AND pk.discarded_at IS NULL
      LEFT JOIN users u ON u.id = pi.packed_by_id
      WHERE pi.order_item_id = i.id ORDER BY pi.packed_at DESC LIMIT 1
    ) packed ON TRUE
    LEFT JOIN LATERAL (
      SELECT u.name, pi.qa_verified_at AS at FROM package_items pi
      JOIN packages pk ON pk.id = pi.package_id AND pk.discarded_at IS NULL
      LEFT JOIN users u ON u.id = pi.qa_verified_by_id
      WHERE pi.order_item_id = i.id AND pi.qa_verified_at IS NOT NULL
      ORDER BY pi.qa_verified_at DESC LIMIT 1
    ) qa ON TRUE
    WHERE i.id = ANY(${batch}::uuid[])`;

  const rows = inBatches(
    ids.map((r) => r.id),
    load,
    (i) => [
      i.number,
      i.sku,
      i.name,
      i.quantity,
      i.pickedQuantity,
      i.pickStatus,
      personName({ name: i.pickedBy ?? "" }),
      kit.time(i.pickedAt),
      personName({ name: i.packedBy ?? "" }),
      kit.time(i.packedAt),
      personName({ name: i.qaBy ?? "" }),
      kit.time(i.qaAt),
      i.voided,
    ],
  );
  return {
    filename: `woolrus-order-items-${from}-${to}.csv`,
    header: kit.header(ORDER_ITEM_COLUMNS),
    rows: kit.capped(rows),
  };
}
