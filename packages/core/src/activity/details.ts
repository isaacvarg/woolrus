import type { Prisma } from "@woolrus/db";
import { isPiiKey, isSecretKey } from "@woolrus/logger";

// SPEC-order-activity "Details": an expanded entry shows what changed, never secrets or customer
// details (the logger's key lists), nor internal ids and versions, which mean nothing to a reader.

const isInternalKey = (key: string) =>
  key === "id" || /[a-z]Id$/.test(key) || /_id$/.test(key) || key === "version";

const hidden = (key: string) => isInternalKey(key) || isPiiKey(key) || isSecretKey(key);

/** The value without hidden keys at any depth; undefined when nothing is left. */
function clean(value: Prisma.JsonValue): Prisma.JsonValue | undefined {
  if (Array.isArray(value)) {
    const items = value.map(clean).filter((v) => v !== undefined);
    return items.length > 0 ? items : undefined;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([key]) => !hidden(key))
      .map(([key, v]) => [key, clean(v as Prisma.JsonValue)] as const)
      .filter(([, v]) => v !== undefined);
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }
  return value === null ? undefined : value;
}

/** An audit row's before and after for the feed, or null when neither has anything to show. */
export function cleanDetails(
  before: Prisma.JsonValue,
  after: Prisma.JsonValue,
): { before: Prisma.JsonValue; after: Prisma.JsonValue } | null {
  const b = clean(before) ?? null;
  const a = clean(after) ?? null;
  return b === null && a === null ? null : { before: b, after: a };
}
