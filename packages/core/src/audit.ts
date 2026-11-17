import type { DbTx, Prisma } from "@woolrus/db";
import { createLogger } from "@woolrus/logger";
import type { ActivityAction } from "./activity/actions";
import type { Actor } from "./permissions";

const log = createLogger({ module: "audit" });

/**
 * Entity types whose audit rows are about one order, so they must carry its `orderId`
 * (SPEC-order-activity "Order on audit rows").
 */
export const ORDER_SCOPED_ENTITIES = [
  "Order",
  "OrderItem",
  "Package",
  "PackageItem",
  "PackageCheckTrip",
  "ShippingLabel",
  "Note",
  "QualityIssue",
  "ItemVoid",
] as const;

export type OrderScopedEntity = (typeof ORDER_SCOPED_ENTITIES)[number];

const orderScoped: ReadonlySet<string> = new Set(ORDER_SCOPED_ENTITIES);

/**
 * The registry actions an entity's audit row may use: every plain key, plus the entity's own
 * qualified bare verbs (`Note.create` → `create` on a Note).
 */
export type OrderScopedAction<E extends OrderScopedEntity> = ActivityAction extends infer K
  ? K extends `${E}.${infer Verb}`
    ? Verb
    : K extends `${OrderScopedEntity}.${string}`
      ? never
      : K
  : never;

type AuditFields = {
  entityId: string;
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  /** Defaults to the database clock. Workflow passes its `now` so audit and stage events agree. */
  at?: Date;
};

/**
 * An order-scoped row names a registry action and its order; any other row is free-form. A caller
 * whose `entityType` is a plain `string` gets the free-form shape, and the runtime guard instead.
 */
export type AuditEventInput<E extends string> = AuditFields &
  (E extends OrderScopedEntity
    ? {
        entityType: E;
        action: OrderScopedAction<E>;
        /**
         * The order this row is about: the order itself, or the order that owns the line, package,
         * label, note, issue, void or check trip. The order's activity feed reads by it.
         */
        orderId: string;
      }
    : { entityType: E; action: string; orderId?: string });

/** Dev and test fail loudly; production keeps the user's action and logs the gap. */
const guardStrict = () => {
  const env = process.env.NODE_ENV;
  return env === "development" || env === "test";
};

export async function recordAudit<E extends string>(
  tx: DbTx,
  actor: Actor,
  event: { entityType: E } & AuditEventInput<E>,
): Promise<void> {
  const row = event as AuditFields & { entityType: string; action: string; orderId?: string };
  const { entityType, entityId, action, orderId } = row;
  if (!orderId && orderScoped.has(entityType)) {
    const message = `recordAudit: ${entityType} ${action} has no orderId; it won't show in the order's activity`;
    if (guardStrict()) throw new Error(message);
    log.warn({ entityType, entityId, action }, message);
  }
  await tx.auditEvent.create({
    data: {
      ...row,
      actorId: actor.userId,
      stationId: actor.stationId,
      requestId: actor.requestId,
    },
  });
}

/** The verbs registered under a dotted prefix: `ActionVerb<"pick">` is `"scan" | "pickLine" | …`. */
export type ActionVerb<Prefix extends string> = ActivityAction extends infer K
  ? K extends `${Prefix}.${infer Verb}`
    ? Verb
    : never
  : never;
