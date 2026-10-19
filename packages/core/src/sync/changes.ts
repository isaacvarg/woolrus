import type { OrderAddress } from "@woolrus/contracts";
import type { WorkflowStatus } from "@woolrus/db";
import { isClaimLive } from "../workflow/claims";
import type { MappedOrder, MappedOrderItem } from "./mapping";

// Change detection (FR-SYNC-10, SPEC-store-sync "Change detection"). Pure: the import loads both
// sides and decides what to do with the diff (apply, cancel, hold, flag).

export type DiffableLine = Pick<MappedOrderItem, "wooLineItemId" | "name" | "sku" | "quantity">;

/** The tracked fields of an order, stored or incoming. Anything else is noise. */
export type DiffableOrder = Pick<
  MappedOrder,
  | "wooStatus"
  | "customerName"
  | "customerEmail"
  | "shippingAddress"
  | "billingAddress"
  | "customerNote"
  | "shippingMethod"
  | "refundedCents"
> & { items: DiffableLine[] };

type Change<T> = { from: T; to: T };
type Customer = { name: string; email: string | null };

/**
 * What the store changed. `refunds` is the refunded total: an order's payload doesn't say which
 * lines a refund covered, and voiding refunded quantities is `exceptions`' job anyway.
 */
export type ChangeSummary = {
  status?: Change<string>;
  shippingAddress?: Change<OrderAddress>;
  billingAddress?: Change<OrderAddress>;
  customerNote?: Change<string | null>;
  shippingMethod?: Change<string | null>;
  customer?: Change<Customer>;
  refunds?: Change<number>;
  lines: {
    added: DiffableLine[];
    removed: DiffableLine[];
    quantity: { wooLineItemId: number; name: string; from: number; to: number }[];
  };
};

export function diffOrder(stored: DiffableOrder, incoming: DiffableOrder): ChangeSummary {
  const diff: ChangeSummary = { lines: diffLines(stored.items, incoming.items) };
  const track = <K extends keyof ChangeSummary, T>(
    key: K,
    from: T,
    to: T,
    same: (a: T, b: T) => boolean = Object.is,
  ) => {
    if (!same(from, to)) Object.assign(diff, { [key]: { from, to } });
  };

  track("status", stored.wooStatus, incoming.wooStatus);
  track("shippingAddress", stored.shippingAddress, incoming.shippingAddress, sameAddress);
  track("billingAddress", stored.billingAddress, incoming.billingAddress, sameAddress);
  track("customerNote", stored.customerNote, incoming.customerNote);
  track("shippingMethod", stored.shippingMethod, incoming.shippingMethod);
  track(
    "customer",
    { name: stored.customerName, email: stored.customerEmail },
    { name: incoming.customerName, email: incoming.customerEmail },
    (a, b) => a.name === b.name && a.email === b.email,
  );
  track("refunds", stored.refundedCents, incoming.refundedCents);
  return diff;
}

export function hasChanges(diff: ChangeSummary): boolean {
  const { lines, ...fields } = diff;
  return (
    Object.keys(fields).length > 0 ||
    lines.added.length > 0 ||
    lines.removed.length > 0 ||
    lines.quantity.length > 0
  );
}

function diffLines(stored: DiffableLine[], incoming: DiffableLine[]): ChangeSummary["lines"] {
  const before = new Map(stored.map((line) => [line.wooLineItemId, line]));
  const after = new Map(incoming.map((line) => [line.wooLineItemId, line]));
  const pick = ({ wooLineItemId, name, sku, quantity }: DiffableLine) => ({
    wooLineItemId,
    name,
    sku,
    quantity,
  });
  return {
    added: incoming.filter((line) => !before.has(line.wooLineItemId)).map(pick),
    removed: stored.filter((line) => !after.has(line.wooLineItemId)).map(pick),
    quantity: stored.flatMap((line) => {
      const next = after.get(line.wooLineItemId);
      return next && next.quantity !== line.quantity
        ? [
            {
              wooLineItemId: line.wooLineItemId,
              name: line.name,
              from: line.quantity,
              to: next.quantity,
            },
          ]
        : [];
    }),
  };
}

/** Same set fields with the same values; key order and `undefined` values don't matter. */
function sameAddress(a: OrderAddress, b: OrderAddress): boolean {
  const set = (x: OrderAddress) =>
    Object.entries(x)
      .filter(([, v]) => v !== undefined)
      .sort(([k1], [k2]) => k1.localeCompare(k2));
  return JSON.stringify(set(a)) === JSON.stringify(set(b));
}

/** What `isUntouched` needs to know about a stored order; counts are of rows hanging off it. */
export type UntouchedSnapshot = {
  status: WorkflowStatus;
  claimedById: string | null;
  claimedAt: Date | null;
  items: { pickedQuantity: number }[];
  packages: number;
  voids: number;
  qualityIssues: number;
  notes: number;
};

/**
 * Nobody has started on the order, so the store's change can be applied (or the order cancelled)
 * without asking anyone. Any trace of work, even an undone void or an expired claim's picks, counts.
 */
export function isUntouched(
  order: UntouchedSnapshot,
  claimExpiryMinutes: number,
  now: Date,
): boolean {
  return (
    order.status === "PENDING" &&
    !isClaimLive(order, claimExpiryMinutes, now) &&
    order.items.every((item) => item.pickedQuantity === 0) &&
    order.packages === 0 &&
    order.voids === 0 &&
    order.qualityIssues === 0 &&
    order.notes === 0
  );
}
