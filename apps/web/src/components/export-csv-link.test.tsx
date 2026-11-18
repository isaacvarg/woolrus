// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { messages } from "@woolrus/i18n";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoidsManager } from "@/app/(app)/voids/voids-manager";
import { ExportCsvLink, exportQuery } from "./export-csv-link";

// SPEC-reporting "CSV exports": the button carries the screen's filters and the browser's zone,
// and a list shows it only to `report.read` holders.

vi.mock("@/lib/orpc", () => ({
  orpc: {
    voids: {
      list: {
        infiniteOptions: () => ({
          queryKey: ["voids"],
          queryFn: async () => ({ groups: [], nextCursor: null }),
          initialPageParam: undefined,
          getNextPageParam: () => undefined,
        }),
      },
    },
  },
}));

afterEach(cleanup);

const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <NextIntlClientProvider locale="en" messages={messages.en} timeZone="UTC">
        {ui}
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );

describe("exportQuery", () => {
  it("drops empty values and repeats lists", () => {
    expect(
      exportQuery({ search: "", statuses: ["PACKING", "QA"], sort: "number", type: undefined }),
    ).toBe("statuses=PACKING&statuses=QA&sort=number");
  });
});

describe("ExportCsvLink", () => {
  it("links to the export with the filters and the browser's time zone", () => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    wrap(<ExportCsvLink path="/api/issues/export.csv" params={{ status: "open" }} />);
    const link = screen.getByRole("link", { name: "Export CSV" });
    expect(link.getAttribute("href")).toBe(
      `/api/issues/export.csv?${new URLSearchParams({ status: "open", timeZone: zone })}`,
    );
    expect(link.hasAttribute("download")).toBe(true);
  });
});

describe("Voids list", () => {
  it("shows Export CSV only with report.read", () => {
    wrap(<VoidsManager canResolve={false} canExport={false} initialTab="unresolved" />);
    expect(screen.queryByRole("link", { name: "Export CSV" })).toBeNull();
    cleanup();
    wrap(<VoidsManager canResolve={false} canExport initialTab="resolved" />);
    expect(screen.getByRole("link", { name: "Export CSV" }).getAttribute("href")).toMatch(
      /^\/api\/voids\/export\.csv\?status=resolved&timeZone=/,
    );
  });
});
