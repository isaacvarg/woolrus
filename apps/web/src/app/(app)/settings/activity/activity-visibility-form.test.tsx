// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { messages } from "@woolrus/i18n";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityVisibilitySection } from "./activity-visibility-form";

// SPEC-order-activity "UI": Settings → Activity, roles × parts as switches that save at once.

const update = vi.fn(async (input: { activityVisibility: unknown }) => ({
  activityVisibility: input.activityVisibility,
}));

vi.mock("@/lib/orpc", () => ({
  orpc: {
    settings: {
      get: {
        queryKey: () => ["settings"],
        queryOptions: () => ({
          queryKey: ["settings"],
          queryFn: async () => ({ activityVisibility: { QA: { details: false } } }),
        }),
      },
      update: {
        mutationOptions: (options: object) => ({ mutationFn: update, ...options }),
      },
    },
  },
}));
vi.mock("@/components/ui/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  cleanup();
  update.mockClear();
});

const checked = (name: string) =>
  (screen.getByRole("switch", { name }) as HTMLInputElement).checked;

function show(locale: "en" | "es" = "en") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <NextIntlClientProvider locale={locale} messages={messages[locale]} timeZone="UTC">
      <QueryClientProvider client={queryClient}>
        <ActivityVisibilitySection />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  return userEvent.setup();
}

describe("Settings → Activity", () => {
  it("shows a switch per role and part, on unless the setting turns it off; no Admin row", async () => {
    show();
    await screen.findByRole("table");
    // Picker, Packer, QA, Shipper and the add-on roles Rate Lab and Reports; four parts each.
    expect(screen.getAllByRole("switch")).toHaveLength(6 * 4);
    expect(screen.getByRole("rowheader", { name: "Reports" })).toBeTruthy();
    expect(screen.queryByRole("rowheader", { name: "Admin" })).toBeNull();
    expect(checked("People for Packer")).toBe(true);
    expect(checked("Change details for QA")).toBe(false);
  });

  it("saves the whole setting when a switch changes", async () => {
    const user = show();
    await user.click(await screen.findByRole("switch", { name: "People for Packer" }));
    expect(update.mock.calls[0]?.[0]).toEqual({
      activityVisibility: { QA: { details: false }, PACKER: { people: false } },
    });
  });

  it("is worded in Spanish", async () => {
    show("es");
    await screen.findByRole("switch", { name: "Personas para Empacador" });
  });
});
