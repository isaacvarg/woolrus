import type { DbTx } from "@woolrus/db";

/** The user fields `displayName` needs, for a Prisma `select`. */
export const nameFields = { name: true, email: true } as const;

/**
 * How workflow shows a person: their name, or their email until they have one (magic-link sign-up
 * creates users with an empty name).
 */
export function displayName(user: { name: string; email: string }): string {
  return user.name.trim() || user.email;
}

/** The claim holder's name for a `claimedByOther` conflict. */
export async function holderName(tx: DbTx, userId: string | null): Promise<string> {
  const holder = userId
    ? await tx.user.findUnique({ where: { id: userId }, select: nameFields })
    : null;
  return holder ? displayName(holder) : "";
}
