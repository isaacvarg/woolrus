import type { ActivityItem } from "@woolrus/contracts";
import { describe, expect, it } from "vitest";
import { groupItems } from "./group";

const ana = { id: "0199e6a0-0000-7000-8000-00000000000a", name: "Ana" };
const bruno = { id: "0199e6a0-0000-7000-8000-00000000000b", name: "Bruno" };
const t0 = Date.parse("2026-11-17T10:00:00Z");
let n = 0;

function item(min: number, over: Partial<ActivityItem> = {}): ActivityItem {
  n += 1;
  return {
    id: `0199e6a0-0000-7000-8000-${String(n).padStart(12, "0")}`,
    at: new Date(t0 + min * 60_000),
    category: "packing",
    action: "package.scan",
    entityType: "Package",
    actor: ana,
    system: null,
    station: null,
    target: { kind: "box", number: 1 },
    params: {},
    details: null,
    ...over,
  };
}

const groups = new Set(["package.scan", "pick.scan"]);
const group = (items: ActivityItem[]) => groupItems(items, (i) => groups.has(i.action));

describe("groupItems", () => {
  it("joins consecutive repeats by one person, action and target under 5 minutes apart", () => {
    const items = [item(12), item(9), item(6), item(2)];
    const [entry, ...rest] = group(items);
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({ count: 4, at: items[0]?.at, firstAt: items[3]?.at });
    expect(entry?.members.map((m) => m.id)).toEqual(items.map((i) => i.id));
  });

  it("splits at a gap of 5 minutes or more", () => {
    const entries = group([item(10), item(5), item(4)]);
    expect(entries.map((e) => e.count)).toEqual([1, 2]);
    expect(entries[0]?.members).toEqual([]);
  });

  it("splits on another person, action, target, or anything in between", () => {
    const entries = group([
      item(10),
      item(9, { actor: bruno }),
      item(8, { target: { kind: "box", number: 2 } }),
      item(7, { action: "pick.scan" }),
      item(6),
      item(5, { action: "stage.move", category: "status", target: null }),
      item(4),
    ]);
    expect(entries.map((e) => e.count)).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });

  it("never groups actions that don't group, or system work", () => {
    const issue = { action: "issue.report", category: "problems" as const };
    expect(group([item(3, issue), item(2, issue)]).map((e) => e.count)).toEqual([1, 1]);
    const sys = { actor: null, system: "store-sync" };
    expect(group([item(3, sys), item(2, sys)]).map((e) => e.count)).toEqual([1, 1]);
  });
});
