// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import type { OrderActivitySummary, StageInterval, StagePeople } from "@woolrus/contracts";
import { messages } from "@woolrus/i18n";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it } from "vitest";
import { ActivitySummary } from "./activity-summary";

// SPEC-order-activity "UI": one row per stage reached, a waiting/working bar per work interval
// (each Packing round of a repack), the batch a pick began in, and who worked each stage.

const MIN = 60_000;
const at = (min: number) => new Date(Date.UTC(2026, 10, 17, 10, min));

const queue = (start: number, end: number): StageInterval => ({
  start: at(start),
  end: at(end),
  running: false,
  statusMs: (end - start) * MIN,
  waitingMs: null,
  workingMs: null,
  firstActionAt: null,
  batch: null,
});
const work = (start: number, first: number, end: number, over: Partial<StageInterval> = {}) => ({
  ...queue(start, end),
  waitingMs: (first - start) * MIN,
  workingMs: (end - first) * MIN,
  firstActionAt: at(first),
  ...over,
});

const summary: OrderActivitySummary = {
  stages: [
    { stage: "PENDING", statusMs: 10 * MIN, intervals: [queue(0, 10)] },
    {
      stage: "PICKING",
      statusMs: 10 * MIN,
      intervals: [work(10, 10, 20, { batch: { number: 7, orders: 4 } })],
    },
    {
      stage: "PACKING",
      statusMs: 95 * MIN,
      intervals: [work(20, 30, 45), work(60, 64, 140, { running: true })],
    },
    { stage: "QA", statusMs: 10 * MIN, intervals: [work(45, 50, 55)] },
    { stage: "READY", statusMs: 0, intervals: [] },
  ],
  onHoldMs: 5 * MIN,
};
const people: StagePeople[] = [
  {
    stage: "PACKING",
    people: [
      {
        id: "0199e6a0-0000-7000-8000-00000000000b",
        name: "Bruno",
        count: 5,
        firstAt: at(30),
        lastAt: at(66),
        spanMs: 36 * MIN,
      },
    ],
  },
];

afterEach(cleanup);

function show(s: OrderActivitySummary = summary) {
  render(
    <NextIntlClientProvider locale="en" messages={messages.en} timeZone="UTC">
      <ActivitySummary summary={s} people={people} />
    </NextIntlClientProvider>,
  );
}

const row = (stage: string) => {
  const found = document.querySelector<HTMLElement>(`[data-stage="${stage}"]`);
  if (!found) throw new Error(`no ${stage} row`);
  return found;
};

describe("ActivitySummary", () => {
  it("shows the stages reached with their status time, and no bar for queues", () => {
    show();
    expect(
      [...document.querySelectorAll("[data-stage]")].map((r) => r.getAttribute("data-stage")),
    ).toEqual(["PENDING", "PICKING", "PACKING", "QA"]);
    expect(row("PENDING").textContent).toContain("10 min");
    expect(within(row("PENDING")).queryByRole("img")).toBeNull();
    expect(row("PACKING").textContent).toContain("1 h 35 min");
    screen.getByText("On hold for 5 min, counted in no stage.");
  });

  it("splits each work interval into waiting and working, one bar per packing round", () => {
    show();
    const bars = within(row("PACKING")).getAllByRole("img");
    expect(bars.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Waiting 10 min, working 15 min",
      "Waiting 4 min, working 1 h 16 min",
    ]);
    expect(row("PACKING").textContent).toContain("Round 2: 1 h 20 min");
    expect(row("PACKING").textContent).toContain("Working 15 min (first to last action)");
    expect(within(row("PACKING")).getByText("Now")).toBeTruthy();
  });

  it("names the batch a pick began in, and who worked each stage", () => {
    show();
    expect(row("PICKING").textContent).toContain("Picked in batch 7 with 4 orders");
    expect(row("PACKING").textContent).toContain("Bruno: 5 actions, 10:30 AM–11:06 AM (36 min)");
  });

  it("renders nothing for an order with no stage time", () => {
    show({ stages: summary.stages.map((s) => ({ ...s, intervals: [] })), onHoldMs: 0 });
    expect(screen.queryByTestId("activity-summary")).toBeNull();
  });
});

describe("ActivitySummary with parts hidden", () => {
  it("shows who worked each stage without the times when only people are visible", () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages.en} timeZone="UTC">
        <ActivitySummary people={people} />
      </NextIntlClientProvider>,
    );
    const packing = screen.getByTestId("activity-summary").querySelector('[data-stage="PACKING"]');
    expect(packing?.textContent).toContain("Bruno");
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByText(/Working time runs/)).toBeNull();
  });

  it("shows the times without anyone's name when people are hidden", () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages.en} timeZone="UTC">
        <ActivitySummary summary={summary} />
      </NextIntlClientProvider>,
    );
    expect(screen.getAllByRole("img").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Bruno/)).toBeNull();
  });
});
