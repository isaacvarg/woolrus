import { recomputePriorities } from "@woolrus/core";
import { createDb } from "@woolrus/db";

const db = createDb();

/** Name prefixes of the rules this worker's tests created, for `deleteCreatedRules`. */
const tags: string[] = [];

/** Remembers `tag` so `deleteCreatedRules` removes rules named with it, even after a timeout. */
export function trackRules(tag: string): string {
  tags.push(tag);
  return tag;
}

/**
 * Deletes the rules whose name starts with a tracked tag and recomputes open orders' priority, as
 * the API would. Called from `afterAll` too: a timed-out test never reaches its `finally`.
 */
export async function deleteCreatedRules() {
  const prefixes = tags.splice(0);
  if (prefixes.length === 0) return;
  await db.$transaction(async (tx) => {
    const { count } = await tx.priorityRule.deleteMany({
      where: { OR: prefixes.map((tag) => ({ name: { startsWith: tag } })) },
    });
    if (count > 0) await recomputePriorities(tx);
  });
}
