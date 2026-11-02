import type { Db } from "@woolrus/db";
import type { ErrorCode } from "@woolrus/i18n";
import type { StoreAdapter } from "../adapters/woocommerce/adapter";
import { StoreError, type StoreErrorKind } from "../adapters/woocommerce/errors";
import { recordAudit } from "../audit";
import { markNotePushed, type NoteToPush, notesToPush } from "../notes/push";
import { shippingActor } from "../permissions";
import { configuredStore } from "../sync/schedule";
import { notifyOrderChanged } from "../workflow/notify";
import { trackingProvider } from "./tracking-provider";

// The `woo.push` job (SPEC-shipping "WooCommerce push", FR-SHIP-06/07/10, SRS §7.1 #8). Tracking
// switched off: one customer note with every package's carrier and number, then every unposted
// note, then status Completed. Each step reads what the store already has before it posts, so a job
// that died after any call, or lost a response, runs again without posting anything twice.
// The local Completed is never undone by a failure here.

// TODO(tracking-on): the AST tracking-item path (Settings.wooTrackingEnabled) is a later ticket.

/** Kinds worth another try: the store may be back soon. Everything else needs a person. */
const transientKinds: readonly StoreErrorKind[] = ["unreachable", "rateLimited", "badResponse"];

export type WooPushResult =
  | { outcome: "skipped" }
  | { outcome: "succeeded" }
  | { outcome: "failed"; messageKey: ErrorCode };

/**
 * Runs the push for one order. A transient store failure is recorded on the order and rethrown for
 * pg-boss to retry; a permanent one, or the last attempt, ends the order's push `FAILED` and returns.
 * `store` is null while WooCommerce isn't configured (permanent: `errors.sync.notConfigured`).
 */
export async function pushToWoo(
  db: Db,
  store: StoreAdapter | null,
  { orderId }: { orderId: string },
  { finalAttempt = false }: { finalAttempt?: boolean } = {},
): Promise<WooPushResult> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: { status: true, wooPushStatus: true },
  });
  if (order?.status !== "COMPLETED" || order.wooPushStatus !== "PENDING") {
    return { outcome: "skipped" };
  }
  await db.order.update({ where: { id: orderId }, data: { wooPushAttempts: { increment: 1 } } });

  try {
    if (!store) throw new StoreError("unauthorized", "WooCommerce isn't configured");
    await push(db, store, orderId);
  } catch (error) {
    if (!(error instanceof StoreError)) throw error;
    const messageKey = error.messageKey;
    if (transientKinds.includes(error.kind) && !finalAttempt) {
      await db.order.update({ where: { id: orderId }, data: { wooPushError: messageKey } });
      throw error;
    }
    await db.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: orderId },
        data: { wooPushStatus: "FAILED", wooPushError: messageKey },
      });
      await recordAudit(tx, shippingActor, {
        entityType: "order",
        entityId: orderId,
        action: "woo.push.failed",
        after: { error: messageKey, kind: error.kind },
      });
      await notifyOrderChanged(tx, { id: orderId, status: "COMPLETED" });
    });
    return { outcome: "failed", messageKey };
  }

  await db.$transaction(async (tx) => {
    await tx.order.update({
      where: { id: orderId },
      data: { wooPushStatus: "SUCCEEDED", wooPushedAt: new Date(), wooPushError: null },
    });
    await recordAudit(tx, shippingActor, {
      entityType: "order",
      entityId: orderId,
      action: "woo.push",
    });
    await notifyOrderChanged(tx, { id: orderId, status: "COMPLETED" });
  });
  return { outcome: "succeeded" };
}

async function push(db: Db, store: StoreAdapter, orderId: string): Promise<void> {
  const order = await db.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { wooOrderId: true, wooTrackingNoteId: true },
  });
  const wooId = order.wooOrderId;
  // Notes already matched to a Woolrus note or the tracking note in this run: two notes with the
  // same text each need their own store note.
  const claimed = new Set<number>();
  let existing: Awaited<ReturnType<StoreAdapter["listOrderNotes"]>> | null = null;
  const stored = async () => (existing ??= await store.listOrderNotes(wooId));

  const post = async (text: string, customerNote: boolean): Promise<number> => {
    const match = (await stored()).find(
      (n) => n.note === text && n.customerNote === customerNote && !claimed.has(n.id),
    );
    const id = match
      ? match.id
      : (await store.addOrderNote(wooId, { note: text, customerNote })).noteId;
    claimed.add(id);
    return id;
  };

  if (order.wooTrackingNoteId === null) {
    const text = await trackingNoteText(db, orderId);
    if (text) {
      const noteId = await post(text, true);
      await db.order.update({ where: { id: orderId }, data: { wooTrackingNoteId: noteId } });
    }
  } else {
    claimed.add(order.wooTrackingNoteId);
  }

  for (const note of await notesToPush(db, orderId)) {
    const wooNoteId = await post(noteText(note), note.visibility === "CUSTOMER");
    await markNotePushed(db, { noteId: note.id, wooNoteId });
  }

  await store.completeOrder(wooId);
}

/** WooCommerce emails a customer note without stripping markup, so staff text goes as plain text. */
const plain = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const targetWord = { item: "Line", package: "Package", issue: "Issue", order: "Order" } as const;

export function noteText(note: NoteToPush): string {
  if (note.visibility === "CUSTOMER") return plain(note.content);
  const { photos, voice } = note.attachments;
  const attached = [
    photos > 0 ? `${photos} ${photos === 1 ? "photo" : "photos"}` : null,
    voice > 0 ? `${voice} voice ${voice === 1 ? "memo" : "memos"}` : null,
  ].filter(Boolean);
  const head = `[${note.authorName ?? "Former user"} · ${targetWord[note.target.kind]}: ${note.target.label}]`;
  const tail = attached.length > 0 ? `\n(${attached.join(", ")} in Woolrus)` : "";
  return `${head} ${plain(note.content)}${tail}`;
}

/** One line per active label, in package order; null when the order has no label with a number. */
async function trackingNoteText(db: Db, orderId: string): Promise<string | null> {
  const labels = await db.shippingLabel.findMany({
    where: {
      status: "ACTIVE",
      trackingNumber: { not: null },
      package: { orderId, discardedAt: null },
    },
    include: {
      package: { select: { number: true } },
      carrier: { select: { name: true, label: true } },
    },
    orderBy: [{ package: { number: "asc" } }, { createdAt: "asc" }],
  });
  if (labels.length === 0) return null;
  const lines = labels.map((label) => {
    const number = label.trackingNumber ?? "";
    const provider = trackingProvider(
      label.carrierCode,
      label.carrier?.label ?? label.carrier?.name ?? null,
      number,
    );
    return `Package ${label.package?.number}: ${provider.name} ${number}${provider.link ? `, ${provider.link}` : ""}`;
  });
  return `Your order has shipped:\n${lines.join("\n")}`;
}

/** The worker's handler: the configured store, then `pushToWoo`. */
export async function runWooPushJob(
  db: Db,
  payload: { orderId: string },
  options: { finalAttempt?: boolean } = {},
): Promise<WooPushResult> {
  return pushToWoo(db, await configuredStore(db), payload, options);
}
