import { z } from "zod";
import { base, Id, IdempotencyKey } from "./base";

// Store sync's API (SPEC-store-sync "API", FR-SYNC-06/07/08). Nothing here carries integration
// secrets or store payloads: runs and errors are counts, message keys and WooCommerce ids.

/** Mirrors the database enum; `CARRIERS` is for `carriers`' service sync, later. */
export const SyncType = z.enum(["ORDERS_POLL", "ORDERS_WEBHOOK", "PRODUCTS", "CARRIERS"]);
export type SyncType = z.infer<typeof SyncType>;

export const SyncRunStatus = z.enum(["RUNNING", "SUCCEEDED", "PARTIAL", "FAILED"]);
export type SyncRunStatus = z.infer<typeof SyncRunStatus>;

/**
 * What the nav shows everyone (FR-SYNC-07). `stale` is "failing" when the last finished poll
 * failed, "late" when no poll has succeeded for 3 × the sync interval, else null.
 */
export const SyncStatusView = z.object({
  lastPoll: z
    .object({ startedAt: z.date(), finishedAt: z.date().nullable(), status: SyncRunStatus })
    .nullable(),
  lastSuccessAt: z.date().nullable(),
  lastWebhookAt: z.date().nullable(),
  intervalMinutes: z.number(),
  stale: z.enum(["failing", "late"]).nullable(),
});
export type SyncStatusView = z.infer<typeof SyncStatusView>;

export const SyncRunRow = z.object({
  id: Id,
  type: SyncType,
  status: SyncRunStatus,
  processed: z.number(),
  failed: z.number(),
  /** Message key of a whole-run failure. */
  errorKey: z.string().nullable(),
  errorDetail: z.string().nullable(),
  startedAt: z.date(),
  finishedAt: z.date().nullable(),
});
export type SyncRunRow = z.infer<typeof SyncRunRow>;

export const SYNC_RUNS_PAGE_MAX = 100;

export const ListSyncRunsInput = z.object({
  type: SyncType.optional(),
  /** `nextCursor` of the previous page. Opaque. */
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(SYNC_RUNS_PAGE_MAX).default(25),
});
export type ListSyncRunsInput = z.infer<typeof ListSyncRunsInput>;

export const SyncRunPage = z.object({
  rows: z.array(SyncRunRow),
  nextCursor: z.string().nullable(),
});
export type SyncRunPage = z.infer<typeof SyncRunPage>;

/** One record that failed in a run. `order` is set when the WooCommerce id is an imported order. */
export const SyncRunErrorRow = z.object({
  id: Id,
  externalId: z.string(),
  messageKey: z.string(),
  detail: z.string().nullable(),
  order: z.object({ id: Id, number: z.string() }).nullable(),
  createdAt: z.date(),
});
export type SyncRunErrorRow = z.infer<typeof SyncRunErrorRow>;

export const SyncTarget = z.enum(["orders", "products"]);
export type SyncTarget = z.infer<typeof SyncTarget>;

export const RunSyncInput = z.object({ idempotencyKey: IdempotencyKey, target: SyncTarget });
export type RunSyncInput = z.infer<typeof RunSyncInput>;

export const RunSyncResult = z.object({ target: SyncTarget, queued: z.boolean() });
export type RunSyncResult = z.infer<typeof RunSyncResult>;

/** The store's own units, as WooCommerce names them. */
export const StoreUnits = z.object({
  weight: z.enum(["lbs", "oz", "kg", "g"]),
  dimension: z.enum(["in", "cm", "mm", "m", "yd"]),
});

export const TestConnectionResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), units: StoreUnits }),
  z.object({ ok: z.literal(false), messageKey: z.string() }),
]);
export type TestConnectionResult = z.infer<typeof TestConnectionResult>;

export const sync = {
  status: base
    .route({ method: "GET", path: "/sync/status", tags: ["Sync"], summary: "When sync last ran" })
    .output(SyncStatusView),

  runs: base
    .route({ method: "GET", path: "/sync/runs", tags: ["Sync"], summary: "The sync log" })
    .input(ListSyncRunsInput)
    .output(SyncRunPage),

  runErrors: base
    .route({
      method: "GET",
      path: "/sync/runs/{id}/errors",
      tags: ["Sync"],
      summary: "Records that failed in a sync run",
    })
    .input(z.object({ id: Id }))
    .output(z.array(SyncRunErrorRow)),

  run: base
    .route({ method: "POST", path: "/sync/run", tags: ["Sync"], summary: "Queue a sync now" })
    .input(RunSyncInput)
    .output(RunSyncResult),

  testConnection: base
    .route({
      method: "POST",
      path: "/sync/test-connection",
      tags: ["Sync"],
      summary: "Check the saved WooCommerce URL and keys",
    })
    .output(TestConnectionResult),
};
