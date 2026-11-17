// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  type ActivityEntry,
  type ActivityItem,
  type OrderActivityFeed,
  SummaryStage,
} from "@woolrus/contracts";
import { messages } from "@woolrus/i18n";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityPanel } from "./activity-panel";

// SPEC-order-activity "UI": filter chips with counts, grouped entries that expand, details, and
// the generic line for an action with no wording.

const ana = { id: "0199e6a0-0000-7000-8000-00000000000a", name: "Ana" };
const at = (min: number) => new Date(Date.UTC(2026, 10, 17, 10, min));

const item = (id: number, over: Partial<ActivityItem>): ActivityItem => ({
  id: `0199e6a0-0000-7000-8000-${String(id).padStart(12, "0")}`,
  at: at(id),
  category: "status",
  action: "order.claim",
  entityType: "Order",
  actor: ana,
  system: null,
  station: null,
  target: null,
  params: {},
  details: null,
  ...over,
});
const single = (i: ActivityItem): ActivityEntry => ({ ...i, count: 1, firstAt: i.at, members: [] });

const scans = [3, 2, 1].map((n) =>
  item(n, {
    category: "packing",
    action: "package.scan",
    entityType: "Package",
    target: { kind: "box", number: 1 },
  }),
);
/** No stage events: the summary renders nothing. */
const noSummary = {
  summary: {
    stages: SummaryStage.options.map((stage) => ({ stage, statusMs: 0, intervals: [] })),
    onHoldMs: 0,
  },
  people: [],
} satisfies Pick<OrderActivityFeed, "summary" | "people">;
const feed: OrderActivityFeed = {
  ...noSummary,
  truncated: false,
  entries: [
    single(
      item(9, {
        action: "stage.move",
        actor: null,
        system: "store-sync",
        params: { from: "PICKING", to: "ON_HOLD", reason: "Address" },
      }),
    ),
    single(
      item(8, {
        category: "packing",
        // No wording: renders the generic line.
        action: "package.legacyChange",
        entityType: "Package",
        target: { kind: "box", number: 2 },
        details: { before: { weightOz: 36 }, after: { weightOz: 41 } },
      }),
    ),
    { ...(scans[0] as ActivityItem), count: 3, firstAt: at(1), members: scans },
  ],
};

/** What the mocked query answers; a test can swap it and `afterEach` puts `feed` back. */
let shownFeed: OrderActivityFeed = feed;

vi.mock("@/lib/orpc", () => ({
  orpc: {
    orders: {
      activity: {
        queryOptions: ({ input }: { input: { id: string } }) => ({
          queryKey: ["activity", input.id],
          queryFn: async () => shownFeed,
        }),
      },
    },
  },
}));

afterEach(() => {
  cleanup();
  shownFeed = feed;
});

function show() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <NextIntlClientProvider locale="en" messages={messages.en} timeZone="UTC">
      <QueryClientProvider client={queryClient}>
        <ActivityPanel id="0199e6a0-0000-7000-8000-000000000001" />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  return userEvent.setup();
}

const entries = () => within(screen.getByRole("list")).getAllByRole("listitem");

describe("ActivityPanel", () => {
  it("words stage moves and system work, and falls back to the generic line", async () => {
    show();
    const [move, weight] = await screen.findAllByRole("listitem");
    expect(move?.textContent).toContain("Moved from Picking to On Hold");
    expect(move?.textContent).toContain("Store sync");
    expect(move?.textContent).toContain("Address");
    expect(weight?.textContent).toContain("Changed a box");
    expect(weight?.textContent).toContain("Box 2");
  });

  it("filters by category, with counts", async () => {
    const user = show();
    await screen.findAllByRole("listitem");
    const filters = screen.getByRole("radiogroup", { name: "Filter by category" });
    expect(
      within(filters)
        .getByRole("radio", { name: /All\s*3/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await user.click(within(filters).getByRole("radio", { name: /Packing\s*2/ }));
    expect(entries()).toHaveLength(2);
    expect(entries()[0]?.textContent).toContain("Changed a box");
  });

  it("expands a grouped entry to its members, and an entry to what changed", async () => {
    const user = show();
    await screen.findAllByRole("listitem");
    screen.getByText(/3 times, 10:01.*10:03/);
    await user.click(screen.getByRole("button", { name: "Show each" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(6);

    await user.click(screen.getByRole("button", { name: "What changed" }));
    screen.getByText("36 → 41");
  });
});

describe("ActivityPanel notes", () => {
  it("links a note entry to the order's Notes tab, without its text", async () => {
    shownFeed = {
      ...noSummary,
      truncated: false,
      entries: [single(item(5, { category: "notes", action: "create", entityType: "Note" }))],
    };
    show();
    const [note] = await screen.findAllByRole("listitem");
    expect(note?.textContent).toContain("Wrote a note");
    const link = within(note as HTMLElement).getByRole("link", { name: "Open the notes" });
    expect(link.getAttribute("href")).toBe(
      "/orders/0199e6a0-0000-7000-8000-000000000001?tab=notes",
    );
    expect(within(note as HTMLElement).queryByRole("button", { name: "What changed" })).toBeNull();
  });
});
