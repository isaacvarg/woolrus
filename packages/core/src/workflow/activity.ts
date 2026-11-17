import { type OrderActivity, OrderActivityInput } from "@woolrus/contracts";
import type { DbTx } from "@woolrus/db";
import { type Actor, assertCan } from "../permissions";

const DAY_MS = 86_400_000;

/** `now` as a YYYY-MM-DD calendar day in `timeZone`. */
function dayIn(now: Date, timeZone: string): string {
  // en-CA formats dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** The `count` calendar days ending on `last` (YYYY-MM-DD), oldest first. */
function daysEnding(last: string, count: number): string[] {
  const end = Date.parse(`${last}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) =>
    new Date(end - (count - 1 - i) * DAY_MS).toISOString().slice(0, 10),
  );
}

type DayCount = { day: string; n: number };

/**
 * Orders received (by WooCommerce order date) and completed per calendar day in the viewer's time
 * zone, for the dashboard chart. Read-only; every day in the range is present.
 */
export async function orderActivity(
  db: DbTx,
  actor: Actor,
  input: OrderActivityInput,
  { now = new Date() }: { now?: Date } = {},
): Promise<OrderActivity> {
  assertCan(actor, "order.read");
  const { days, timeZone } = OrderActivityInput.parse(input);
  const range = daysEnding(dayIn(now, timeZone), days);
  const first = range[0] as string;
  // A day ahead of the first day's UTC midnight covers every zone offset and lets the index help;
  // the exact cut is on the local date.
  const since = new Date(Date.parse(`${first}T00:00:00Z`) - DAY_MS);

  const [received, completed] = await Promise.all([
    db.$queryRaw<DayCount[]>`
      SELECT to_char(ordered_at AT TIME ZONE ${timeZone}, 'YYYY-MM-DD') AS day, count(*)::int AS n
      FROM orders
      WHERE ordered_at >= ${since} AND (ordered_at AT TIME ZONE ${timeZone})::date >= ${first}::date
      GROUP BY 1`,
    db.$queryRaw<DayCount[]>`
      SELECT to_char(completed_at AT TIME ZONE ${timeZone}, 'YYYY-MM-DD') AS day, count(*)::int AS n
      FROM orders
      WHERE completed_at >= ${since}
        AND (completed_at AT TIME ZONE ${timeZone})::date >= ${first}::date
      GROUP BY 1`,
  ]);
  const byDay = (rows: DayCount[]) => new Map(rows.map((row) => [row.day, row.n]));
  const receivedBy = byDay(received);
  const completedBy = byDay(completed);
  return range.map((day) => ({
    day,
    received: receivedBy.get(day) ?? 0,
    completed: completedBy.get(day) ?? 0,
  }));
}
