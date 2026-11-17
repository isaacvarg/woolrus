/** Time since `since`, coarsened for a glance: minutes, then hours, then days. */
export function ageParts(
  since: Date,
  now: number,
): { unit: "Minutes" | "Hours" | "Days"; count: number } {
  const minutes = Math.max(0, Math.floor((now - since.getTime()) / 60_000));
  if (minutes < 60) return { unit: "Minutes", count: minutes };
  if (minutes < 24 * 60) return { unit: "Hours", count: Math.floor(minutes / 60) };
  return { unit: "Days", count: Math.floor(minutes / (24 * 60)) };
}
