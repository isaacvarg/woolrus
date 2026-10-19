import type { Db, SyncStatus, SyncType } from "@woolrus/db";
import type { ErrorCode } from "@woolrus/i18n";
import { StoreError } from "../adapters/woocommerce/errors";

// The sync log (FR-SYNC-06): one SyncRun per run, one SyncRunError per record that failed.

export async function startRun(db: Db, type: SyncType, now: Date): Promise<string> {
  const run = await db.syncRun.create({ data: { type, startedAt: now }, select: { id: true } });
  return run.id;
}

export async function finishRun(
  db: Db,
  id: string,
  result: { status: SyncStatus; processed: number; failed: number; error?: ErrorCode },
): Promise<void> {
  await db.syncRun.update({
    where: { id },
    data: {
      status: result.status,
      recordsProcessed: result.processed,
      recordsFailed: result.failed,
      error: result.error ?? null,
      finishedAt: new Date(),
    },
  });
}

export async function recordRunError(
  db: Db,
  syncRunId: string,
  externalId: string | number,
  error: unknown,
): Promise<void> {
  await db.syncRunError.create({
    data: { syncRunId, externalId: String(externalId), error: formatRunError(error) },
  });
}

/**
 * `<message key>` or `<message key>: <detail>`. The key is what the Sync page translates; the
 * detail names the request or field (StoreError details never carry credentials or payload values).
 */
export function formatRunError(error: unknown): string {
  if (error instanceof StoreError) {
    return error.detail ? `${error.messageKey}: ${error.detail}` : error.messageKey;
  }
  const key: ErrorCode = "errors.sync.importFailed";
  // Prisma's code (e.g. P2002) rather than its message, which can quote the values written.
  const code = (error as { code?: unknown } | null)?.code;
  const detail =
    typeof code === "string"
      ? code
      : error instanceof Error
        ? error.message.trim().split("\n")[0]?.slice(0, 300)
        : undefined;
  return detail ? `${key}: ${detail}` : key;
}

/** The message key for a whole-run failure. */
export function runErrorKey(error: unknown): ErrorCode {
  return error instanceof StoreError ? error.messageKey : "errors.sync.importFailed";
}
