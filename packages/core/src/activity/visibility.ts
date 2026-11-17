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

/**
 * The stored setting, read switch by switch: a role or part that no longer exists is dropped and
 * the rest still apply, so one stale key can't switch every part back on for every role.
 */
export function parseActivityVisibility(json: Prisma.JsonValue): ActivityVisibility {
  const whole = ActivityVisibility.safeParse(json);
  if (whole.success) return whole.data;
  if (!json || typeof json !== "object" || Array.isArray(json)) return {};
  const visibility: ActivityVisibility = {};
  for (const [roleKey, switches] of Object.entries(json)) {
    const role = ActivityVisibilityRole.safeParse(roleKey);
    if (!role.success || !switches || typeof switches !== "object" || Array.isArray(switches)) {
      continue;
    }
    const kept: Partial<Record<ActivityPart, boolean>> = {};
    for (const [partKey, on] of Object.entries(switches)) {
      const part = ActivityPart.safeParse(partKey);
      if (part.success && typeof on === "boolean") kept[part.data] = on;
    }
    visibility[role.data] = kept;
  }
  return visibility;
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

/**
 * Whether the viewer gets a History tab at all. `details` alone doesn't count: details only show
 * inside timeline entries, so without the timeline there would be nothing to render.
 */
export function seesActivity(parts: ActivityParts): boolean {
  return parts.timeline || parts.summary || parts.people;
}

/** The parts this actor gets under the current setting. */
export async function activityPartsFor(db: DbTx, actor: Actor): Promise<ActivityParts> {
  // Read directly, not through the settings service: no row yet means the default, `{}`.
  const row = await db.settings.findFirst({ select: { activityVisibility: true } });
  return visibleParts(actor.roles, parseActivityVisibility(row?.activityVisibility ?? {}));
}
