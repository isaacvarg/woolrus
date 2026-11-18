// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReportsToday } from "@woolrus/contracts";
import { messages } from "@woolrus/i18n";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReportTiles } from "./report-tiles";

// SPEC-reporting "Home dashboard": `report.read` holders get "Shipped today" and "Median cycle
// time, last 7 days", each linking to its report; everyone else sees no tile and no read.

const today: ReportsToday = {
  today: "2026-11-18",
  shippedToday: 1234,
  medianCycleMs: 370 * 60_000,
};
const read = vi.fn(async () => today);

vi.mock("@/lib/orpc", () => ({
  orpc: {
    reports: {
      today: {
        queryOptions: ({ input }: { input: { timeZone: string } }) => ({
          queryKey: ["reports", "today", input.timeZone],
          queryFn: read,
        }),
      },
    },
  },
}));

afterEach(() => {
  cleanup();
  read.mockClear();
});

function show(canRead: boolean, locale: "en" | "es" = "en") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <NextIntlClientProvider locale={locale} messages={messages[locale]} timeZone="UTC">
      <QueryClientProvider client={queryClient}>
        <ReportTiles canRead={canRead} />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

describe("ReportTiles", () => {
  it("shows shipped today and the 7-day median, each linking to its report", async () => {
    show(true);
    const shipped = screen.getByTestId("tile-shipped-today");
    const median = screen.getByTestId("tile-median-cycle");
    expect(within(shipped).getByText("Shipped today")).toBeDefined();
    expect(await within(shipped).findByText("1,234")).toBeDefined();
    expect(within(median).getByText("Median cycle time, last 7 days")).toBeDefined();
    expect(await within(median).findByText("6 h 10 min")).toBeDefined();
    expect(within(shipped).getByRole("link").getAttribute("href")).toBe(
      "/reports/throughput?range=today",
    );
    expect(within(median).getByRole("link").getAttribute("href")).toBe("/reports/cycle-time");
  });

  it("shows a dash while nothing shipped in the 7 days", async () => {
    read.mockResolvedValueOnce({ ...today, shippedToday: 0, medianCycleMs: null });
    show(true);
    expect(await within(screen.getByTestId("tile-shipped-today")).findByText("0")).toBeDefined();
    expect(within(screen.getByTestId("tile-median-cycle")).getByText("—")).toBeDefined();
  });

  it("is in Spanish too", async () => {
    show(true, "es");
    expect(screen.getByText("Enviados hoy")).toBeDefined();
    expect(screen.getByText("Tiempo de ciclo mediano, últimos 7 días")).toBeDefined();
  });

  it("renders nothing and reads nothing without report.read", () => {
    expect(show(false).container.innerHTML).toBe("");
    expect(read).not.toHaveBeenCalled();
  });
});
