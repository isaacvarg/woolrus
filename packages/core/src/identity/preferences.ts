import type { Preferences, UpdatePreferencesInput } from "@woolrus/contracts";
import type { Db } from "@woolrus/db";
import type { UserActor } from "../permissions";

const select = { locale: true, theme: true, sidebarCollapsed: true } as const;

/**
 * FR-SET-03. Any signed-in user, for themselves only: no permission to check, and not audited
 * (a display choice, not a change to anything the warehouse acts on).
 */
export async function getPreferences(db: Db, actor: UserActor): Promise<Preferences> {
  return db.user.findUniqueOrThrow({ where: { id: actor.userId }, select });
}

export async function updatePreferences(
  db: Db,
  actor: UserActor,
  patch: UpdatePreferencesInput,
): Promise<Preferences> {
  return db.user.update({ where: { id: actor.userId }, data: patch, select });
}
