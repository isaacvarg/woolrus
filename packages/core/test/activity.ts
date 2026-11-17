import type { OrderActivityFeed } from "@woolrus/contracts";
import { getOrderActivity } from "../src/activity/timeline";

/** A feed with every part, as a viewer under the default visibility gets it. */
export type FullActivityFeed = Required<OrderActivityFeed>;

/**
 * `getOrderActivity` for tests that read the parts themselves: fails when the viewer was given
 * less than everything, so those tests don't have to check each part is there.
 */
export async function fullActivity(
  ...args: Parameters<typeof getOrderActivity>
): Promise<FullActivityFeed> {
  const feed = await getOrderActivity(...args);
  const { summary, people, entries } = feed;
  if (!summary || !people || !entries) throw new Error("expected every activity part");
  return { ...feed, summary, people, entries };
}
