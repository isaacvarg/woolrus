import type { CreateLabelPrintInput, LabelPrintResult, PrintableLabel } from "@woolrus/contracts";
import type { Db } from "@woolrus/db";
import { PDFDocument } from "pdf-lib";
import type { ObjectStorage } from "../adapters/storage/storage";
import { recordAudit } from "../audit";
import { AppError, notFound } from "../errors";
import { withIdempotency } from "../idempotency";
import { type Actor, assertCan } from "../permissions";

// Printing labels (SPEC-shipping "Print", FR-SHIP-11, SRS §7.1 #2). Two steps: `createLabelPrint`
// records the print and counts it; the GET route then streams the merged PDF with no side effects,
// so a prefetch can never count a print and printing never changes an order's status.

const PRINTABLE_ORDER = ["READY", "COMPLETED"] as const;
/** A print can be fetched for a day; after that the button must be pressed again. */
export const PRINT_TTL_MS = 24 * 60 * 60_000;

const unprintable = () => new AppError("CONFLICT", "errors.shipping.notPrintable");

/**
 * Records a print of every `ACTIVE` label of `orderIds` (in the given order, then package number),
 * or of `labelIds` (in the given order), and bumps each label's count. Replays return the first answer.
 */
export async function createLabelPrint(
  db: Db,
  actor: Actor,
  input: CreateLabelPrintInput,
  { now = new Date() }: { now?: Date } = {},
): Promise<LabelPrintResult> {
  assertCan(actor, "label.print");
  return db.$transaction(async (tx) =>
    withIdempotency(tx, input.idempotencyKey, "shipping.createLabelPrint", actor, async () => {
      const where = {
        status: "ACTIVE" as const,
        storageKey: { not: null },
        package: { discardedAt: null, order: { status: { in: [...PRINTABLE_ORDER] } } },
      };
      const select = {
        id: true,
        package: { select: { number: true, orderId: true } },
      } as const;

      let ordered: { id: string; orderId: string }[];
      if (input.orderIds) {
        const orderIds = [...new Set(input.orderIds)];
        const labels = await tx.shippingLabel.findMany({
          where: { ...where, package: { ...where.package, orderId: { in: orderIds } } },
          select,
        });
        const sorted = labels
          .flatMap((l) =>
            l.package ? [{ id: l.id, orderId: l.package.orderId, n: l.package.number }] : [],
          )
          .sort((a, b) => orderIds.indexOf(a.orderId) - orderIds.indexOf(b.orderId) || a.n - b.n);
        // Every order must be printable and have something to print.
        if (new Set(sorted.map((l) => l.orderId)).size !== orderIds.length) throw unprintable();
        ordered = sorted;
      } else {
        const labelIds = [...new Set(input.labelIds ?? [])];
        const labels = await tx.shippingLabel.findMany({
          where: { ...where, id: { in: labelIds } },
          select,
        });
        if (labels.length !== labelIds.length) throw unprintable();
        const byId = new Map(labels.map((l) => [l.id, l]));
        ordered = labelIds.flatMap((id) => {
          const orderId = byId.get(id)?.package?.orderId;
          return orderId ? [{ id, orderId }] : [];
        });
      }

      const ids = ordered.map((l) => l.id);
      const print = await tx.labelPrint.create({
        data: { createdById: actor.userId, labelIds: ids, createdAt: now },
      });
      await tx.shippingLabel.updateMany({
        where: { id: { in: ids } },
        data: { printCount: { increment: 1 }, lastPrintedAt: now },
      });
      for (const orderId of new Set(ordered.map((l) => l.orderId))) {
        await recordAudit(tx, actor, {
          entityType: "order",
          entityId: orderId,
          action: "label.print",
          after: {
            printId: print.id,
            labelIds: ids.filter((_, i) => ordered[i]?.orderId === orderId),
          },
          at: now,
        });
      }
      return { printId: print.id, labelCount: ids.length };
    }),
  );
}

/**
 * The merged PDF of a print, for the route handler: `label.print`, and the print must be the
 * actor's and under a day old (404 otherwise, so ids can't be probed). Pages are copied as stored.
 */
export async function labelPrintPdf(
  db: Db,
  actor: Actor,
  storage: Pick<ObjectStorage, "get">,
  printId: string,
  { now = new Date() }: { now?: Date } = {},
): Promise<Uint8Array> {
  assertCan(actor, "label.print");
  const print = await db.labelPrint.findUnique({ where: { id: printId } });
  if (
    !print ||
    print.createdById !== actor.userId ||
    now.getTime() - print.createdAt.getTime() > PRINT_TTL_MS
  ) {
    throw notFound();
  }
  const labels = await db.shippingLabel.findMany({
    where: { id: { in: print.labelIds } },
    select: { id: true, storageKey: true },
  });
  const keys = new Map(labels.map((l) => [l.id, l.storageKey]));

  const merged = await PDFDocument.create();
  for (const id of print.labelIds) {
    const key = keys.get(id);
    if (!key) throw notFound();
    const object = await storage.get(key);
    const source = await PDFDocument.load(await new Response(object.body).arrayBuffer());
    for (const page of await merged.copyPages(source, source.getPageIndices()))
      merged.addPage(page);
  }
  return merged.save();
}

/** An order's active, printable labels with their counts, for the Reprint buttons; `label.print`. */
export async function orderPrintableLabels(
  db: Db,
  actor: Actor,
  { orderId }: { orderId: string },
): Promise<PrintableLabel[]> {
  assertCan(actor, "label.print");
  const labels = await db.shippingLabel.findMany({
    where: {
      status: "ACTIVE",
      storageKey: { not: null },
      package: { orderId, discardedAt: null, order: { status: { in: [...PRINTABLE_ORDER] } } },
    },
    select: {
      id: true,
      carrierCode: true,
      serviceCode: true,
      trackingNumber: true,
      printCount: true,
      lastPrintedAt: true,
      package: { select: { number: true } },
    },
  });
  return labels
    .map((l) => ({
      id: l.id,
      packageNumber: l.package?.number ?? 0,
      carrierCode: l.carrierCode,
      serviceCode: l.serviceCode,
      trackingNumber: l.trackingNumber,
      printCount: l.printCount,
      lastPrintedAt: l.lastPrintedAt,
    }))
    .sort((a, b) => a.packageNumber - b.packageNumber);
}
