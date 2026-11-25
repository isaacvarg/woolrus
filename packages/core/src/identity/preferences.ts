import {
  BoxPickerColumns,
  type Preferences,
  type UpdatePreferencesInput,
} from "@woolrus/contracts";
import type { Db } from "@woolrus/db";
import type { UserActor } from "../permissions";

const select = {
  locale: true,
  theme: true,
  sidebarCollapsed: true,
  boxPickerColumns: true,
} as const;

/** The users column is an Int that a CHECK keeps to 1 or 2; this narrows it to the contract's type. */
export const boxPickerColumns = (value: number): BoxPickerColumns => BoxPickerColumns.parse(value);

const toPreferences = (
  row: Omit<Preferences, "boxPickerColumns"> & { boxPickerColumns: number },
) => ({
  ...row,
  boxPickerColumns: boxPickerColumns(row.boxPickerColumns),
});

/**
 * FR-SET-03. Any signed-in user, for themselves only: no permission to check, and not audited
 * (a display choice, not a change to anything the warehouse acts on).
 */
export async function getPreferences(db: Db, actor: UserActor): Promise<Preferences> {
  return toPreferences(await db.user.findUniqueOrThrow({ where: { id: actor.userId }, select }));
}

export async function updatePreferences(
  db: Db,
  actor: UserActor,
  patch: UpdatePreferencesInput,
): Promise<Preferences> {
  return toPreferences(await db.user.update({ where: { id: actor.userId }, data: patch, select }));
}
