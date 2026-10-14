import type { DbTx, Prisma } from "@woolrus/db";
import { AppError } from "./errors";
import type { Actor } from "./permissions";

/**
 * Runs `fn` at most once per key. The stored result is returned for replays.
 * Call inside a transaction so the result and the side effects commit together.
 */
export async function withIdempotency<T>(
  tx: DbTx,
  key: string,
  procedure: string,
  actor: Actor,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = await tx.idempotentRequest.findUnique({ where: { key } });
  if (previous) {
    // Same key reused for a different call is a client bug, not a replay.
    if (previous.procedure !== procedure || previous.userId !== actor.userId) {
      throw new AppError("CONFLICT", "errors.conflict");
    }
    return previous.response as T;
  }
  const result = await fn();
  await tx.idempotentRequest.create({
    data: {
      key,
      procedure,
      userId: actor.userId,
      response: result as Prisma.InputJsonValue,
    },
  });
  return result;
}
