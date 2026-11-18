// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { QualityReport as Report } from "@woolrus/contracts";
import { messages } from "@woolrus/i18n";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QualityReport } from "./quality-report";

// SPEC-reporting "Quality" (criteria 3 and 9): the rate shows from 100 units only, unknown
// barcodes sit in their own column, each chart has its table twin, and the filters reach both the
// read and the export.

const mocks = vi.hoisted(() => ({ search: "", input: null as unknown }));

const report: Report = {
  bucketSize: "week",
  buckets: ["2026-11-02", "2026-11-09"],
  total: 4,
  byType: {
    series: [
      { bucket: "2026-11-02", key: "WRONG_ITEM", count: 2 },
      { bucket: "2026-11-09", key: "DAMAGED_ITEM", count: 2 },
    ],
    totals: [
      { key: "WRONG_ITEM", count: 2 },
      { key: "DAMAGED_ITEM", count: 2 },
    ],
  },
  byDiscoveredStage: { series: [], totals: [] },
  byOriginStage: { series: [], totals: [] },
  byPerson: { series: [], totals: [] },
  people: [
    {
      person: { id: "00000000-0000-7000-8000-000000000001", name: "Ana Packer" },
      stage: "PACKING",
      issues: 2,
      units: 50,
      per1000: null,
    },
    {
      person: { id: "00000000-0000-7000-8000-000000000002", name: "Pat Picker" },
      stage: "PICKING",
      issues: 2,
      units: 200,
      per1000: 10,
    },
  ],
  scans: [
    {
      stage: "PICKING",
      person: { id: "00000000-0000-7000-8000-000000000002", name: "Pat Picker" },
      notOnOrder: 1,
      alreadyDone: 0,
      otherPackage: 0,
      unknownCode: 2,
    },
  ],
  voids: [{ stage: "PICKING", resolution: "REFUNDED", voids: 1, units: 2 }],
};

// jsdom has no media queries or layout: the charts get fixed colours and no size.
vi.mock("@/components/charts/theme", () => ({
  useChartColors: () => ({ text: "#000", grid: "#ccc", surface: "#fff", series: ["#111"] }),
  useChartAnimation: () => false,
  seriesColor: () => "#111",
}));
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(mocks.search) }));
vi.mock("../use-report-range", () => ({
  useReportRange: () => ({
    range: { from: "2026-11-02", to: "2026-11-15", timeZone: "UTC" },
    search: "",
  }),
}));
vi.mock("@/lib/orpc", () => ({
  orpc: {
    reports: {
      quality: {
        queryOptions: ({ input }: { input: unknown }) => {
          mocks.input = input;
          return { queryKey: ["quality", input], queryFn: async () => report };
        },
      },
    },
  },
}));

afterEach(() => {
  cleanup();
  mocks.search = "";
});

function show() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <NextIntlClientProvider locale="en" messages={messages.en} timeZone="UTC">
        <QualityReport />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

describe("QualityReport", () => {
  it("shows each person's rate from 100 units, and says so below it", async () => {
    show();
    const rates = await screen.findByTestId("quality-rates");
    const rows = within(rates).getAllByRole("row");
    const cells = (row: HTMLElement | undefined) =>
      within(row as HTMLElement)
        .getAllByRole("cell")
        .map((c) => c.textContent);
    expect(cells(rows[1])).toEqual(["Ana Packer", "Packing", "2", "50", "Under 100 units"]);
    expect(cells(rows[2])).toEqual(["Pat Picker", "Picking", "2", "200", "10"]);
  });

  it("keeps unknown barcodes out of the blocked-scan total", async () => {
    show();
    const scans = await screen.findByTestId("quality-scans");
    const headers = within(scans)
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(headers.at(-2)).toBe("Total, without unknown");
    expect(headers.at(-1)).toBe("Unknown barcode");
    const cells = within(within(scans).getAllByRole("row")[1] as HTMLElement)
      .getAllByRole("cell")
      .map((c) => c.textContent);
    expect(cells.slice(-2)).toEqual(["1", "2"]);
  });

  it("gives each chart its table, with the week's totals", async () => {
    show();
    const table = await screen.findByRole("table", { name: "Issues by type" });
    expect(
      within(table)
        .getAllByRole("row")
        .map((r) => r.textContent),
    ).toEqual(["Week ofWrong itemDamaged item", "Nov 2, 202620", "Nov 9, 202602", "Total22"]);
  });

  it("sends the URL's filters to the read and to both exports", async () => {
    mocks.search = "severity=MAJOR&status=open&customerReported=true";
    show();
    await screen.findByTestId("quality-rates");
    expect(mocks.input).toMatchObject({
      severity: "MAJOR",
      status: "open",
      customerReported: true,
    });
    const issues = screen.getByRole("link", { name: "Export CSV" }).getAttribute("href");
    expect(issues).toMatch(/^\/api\/reports\/quality\.csv\?/);
    expect(issues).toContain("severity=MAJOR");
    expect(issues).toContain("status=open");
    expect(issues).toContain("customerReported=true");
    const scans = screen
      .getByRole("link", { name: "Export blocked scans CSV" })
      .getAttribute("href");
    // The range only (the issue filters don't apply to scans), plus the browser's zone.
    expect(scans).toMatch(
      /^\/api\/reports\/scan-misses\.csv\?from=2026-11-02&to=2026-11-15&timeZone=[^&]+$/,
    );
  });
});
