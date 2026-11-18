import type { ActivityEntry, ActivityItem, ActivityTarget } from "@woolrus/contracts";

/** SPEC-order-activity "Grouping": repeats further apart than this are separate entries. */
export const GROUP_GAP_MS = 5 * 60_000;

const targetKey = (target: ActivityTarget | null) => JSON.stringify(target);

function joins(entry: ActivityEntry, item: ActivityItem, groups: (item: ActivityItem) => boolean) {
  return (
    groups(item) &&
    item.actor !== null &&
    item.actor.id === entry.actor?.id &&
    item.action === entry.action &&
    targetKey(item.target) === targetKey(entry.target) &&
    entry.firstAt.getTime() - item.at.getTime() < GROUP_GAP_MS
  );
}

const single = (item: ActivityItem): ActivityEntry => ({
  ...item,
  count: 1,
  firstAt: item.at,
  members: [],
});

/**
 * Joins consecutive items (newest first) by the same person, with the same action and target,
 * each under 5 minutes from the next, into one entry with a count, a time range and its members.
 * Actions `groups` says no to, and system work, are always their own entry.
 */
export function groupItems(
  items: readonly ActivityItem[],
  groups: (item: ActivityItem) => boolean,
): ActivityEntry[] {
  const entries: ActivityEntry[] = [];
  for (const item of items) {
    const last = entries.at(-1);
    if (last && joins(last, item, groups)) {
      if (last.members.length === 0) last.members.push(stripped(last));
      last.members.push(item);
      last.count += 1;
      last.firstAt = item.at;
    } else {
      entries.push(single(item));
    }
  }
  return entries;
}

/** The entry's own item, as its first member. */
function stripped({ count: _c, firstAt: _f, members: _m, ...item }: ActivityEntry): ActivityItem {
  return item;
}
