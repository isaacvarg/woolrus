import {
  ActivityPart,
  type ActivityParts,
  ActivityVisibility,
  ActivityVisibilityRole,
} from "@woolrus/contracts";
import type { DbTx, Prisma } from "@woolrus/db";
import type { Actor } from "../permissions";

// Which parts of the activity view a viewer gets (SPEC-order-activity "Visibility"). The server
// leaves the rest out of `orders.activity`, so a hidden part can't be read through the API.

/** Stored JSON that no longer fits the contract reads as `{}`: everyone sees everything. */
export function parseActivityVisibility(json: Prisma.JsonValue): ActivityVisibility {
  const parsed = ActivityVisibility.safeParse(json);
  return parsed.success ? parsed.data : {};
}

/**
 * Admins get every part. Anyone else gets a part when any of their roles has it, and a role has
 * every part it isn't switched off for.
 */
export function visibleParts(
  roles: readonly string[],
  visibility: ActivityVisibility,
): ActivityParts {
  const admin = roles.includes("ADMIN");
  const settable = roles.flatMap((role) => {
    const parsed = ActivityVisibilityRole.safeParse(role);
    return parsed.success ? [parsed.data] : [];
  });
  return Object.fromEntries(
    ActivityPart.options.map((part) => [
      part,
      admin || settable.some((role) => visibility[role]?.[part] !== false),
    ]),
  ) as ActivityParts;
}

/** Whether the viewer gets any part, i.e. whether they get a History tab at all. */
export function seesActivity(parts: ActivityParts): boolean {
  return ActivityPart.options.some((part) => parts[part]);
}

/** The parts this actor gets under the current setting. */
export async function activityPartsFor(db: DbTx, actor: Actor): Promise<ActivityParts> {
  // Read directly, not through the settings service: no row yet means the default, `{}`.
  const row = await db.settings.findFirst({ select: { activityVisibility: true } });
  return visibleParts(actor.roles, parseActivityVisibility(row?.activityVisibility ?? {}));
}
