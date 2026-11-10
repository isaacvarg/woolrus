import type { DbTx } from "@woolrus/db";
import { publicEmail } from "../identity/station-only";

/** The user fields `displayName` needs, for a Prisma `select`. */
export const nameFields = { name: true, email: true } as const;

/**
 * How workflow shows a person: their name, or their email until they have one (magic-link sign-up
 * creates users with an empty name).
 */
export function displayName(user: { name: string; email: string }): string {
  // A station-only placeholder never shows (SPEC-identity amendment 1); their name is required anyway.
  return user.name.trim() || publicEmail(user.email) || "";
}

/** The claim holder's name for a `claimedByOther` conflict. */
export async function holderName(tx: DbTx, userId: string | null): Promise<string> {
  const holder = userId
    ? await tx.user.findUnique({ where: { id: userId }, select: nameFields })
    : null;
  return holder ? displayName(holder) : "";
}
