import type { ActivityParams, ActivityTarget } from "@woolrus/contracts";
import type { DbTx, Prisma } from "@woolrus/db";
import type { SystemActor } from "../../permissions";

/**
 * One thing that happened to the order, from any source, in the shape of an audit row. The
 * timeline words it through the action registry, finds its target and groups it.
 */
export type SourceRecord = {
  /** UUIDv7: breaks ties in write order. */
  id: string;
  at: Date;
  /** A registry key, or an audit row's action. */
  action: string;
  entityType: string;
  entityId: string;
  actorId: string | null;
  actor: { name: string; email: string } | null;
  /** Who did it when `actorId` is null, if the source knows; else the registry's `system`. */
  system?: SystemActor["system"];
  station: string | null;
  before: Prisma.JsonValue;
  after: Prisma.JsonValue;
  /** Parameters the source already knows; the action's `describe` can add to them. */
  params?: ActivityParams;
  /** Set to skip the target worked out from `entityType` and `entityId`. */
  target?: ActivityTarget | null;
  /** False: `before`/`after` aren't details to show. */
  details?: boolean;
};

/**
 * A kind of record the timeline reads for one order: stage events, audit rows, and (with #205)
 * scan misses. Each returns at most `take` records, newest first.
 */
export type ActivitySource = (
  db: DbTx,
  query: { orderId: string; take: number },
) => Promise<SourceRecord[]>;
