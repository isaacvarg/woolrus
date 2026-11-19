// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { StationSetupCodeIssued, StationSummary } from "@woolrus/contracts";
import { messages } from "@woolrus/i18n";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatTimeLeft, SetupCode } from "./setup-code";

// SPEC-identity A3, the Add station dialog after the code is issued: the countdown, and the
// switch to "<name> is set up" once the tablet has redeemed it.

const stations = vi.hoisted(() => ({ list: [] as StationSummary[] }));
const setupCodesKey = ["stations", "setupCodes"];

vi.mock("@/lib/orpc", () => ({
  orpc: {
    stations: {
      list: {
        queryOptions: () => ({
          queryKey: ["stations", "list"],
          queryFn: async () => stations.list,
        }),
      },
      setupCodes: { key: () => setupCodesKey },
    },
  },
}));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  stations.list = [];
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function show(secondsLeft: number) {
  const issued: StationSetupCodeIssued = {
    id: "01a1d1f5-315c-71fc-9db3-9772cb0dbc4e",
    name: "Pack 3",
    code: "7KQ4M-XD2RA",
    expiresAt: new Date(Date.now() + secondsLeft * 1_000),
    qrSvg: "<svg></svg>",
  };
  const onRenew = vi.fn();
  const onDone = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidated = vi.spyOn(queryClient, "invalidateQueries");
  render(
    <NextIntlClientProvider locale="en" messages={messages.en} timeZone="UTC">
      <QueryClientProvider client={queryClient}>
        <SetupCode
          issued={issued}
          onDone={onDone}
          onRenew={onRenew}
          renewing={false}
          renewError={null}
        />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  return { onRenew, onDone, invalidated };
}

const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

describe("formatTimeLeft", () => {
  it("shows minutes and seconds, rounded up", () => {
    expect(formatTimeLeft(10 * 60_000)).toBe("10:00");
    expect(formatTimeLeft(65_000)).toBe("1:05");
    expect(formatTimeLeft(400)).toBe("0:01");
    expect(formatTimeLeft(0)).toBe("0:00");
  });
});

describe("SetupCode", () => {
  it("counts down to zero, then says the code expired and offers a new one", async () => {
    const { onRenew } = show(3);
    expect(screen.getByTestId("setup-code").textContent).toBe("7KQ4M-XD2RA");
    expect(screen.getByText("Expires in 0:03")).toBeTruthy();

    await advance(1_000);
    expect(screen.getByText("Expires in 0:02")).toBeTruthy();

    await advance(2_000);
    expect(screen.getByText("This code has expired. Get a new one to set up Pack 3.")).toBeTruthy();
    expect(screen.queryByTestId("setup-code")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Get a new code" }));
    expect(onRenew).toHaveBeenCalledOnce();
  });

  it("watches the stations and says the station is set up once it appears", async () => {
    const { invalidated } = show(600);
    await advance(0);
    expect(screen.queryByText("Pack 3 is set up")).toBeNull();
    expect(invalidated).not.toHaveBeenCalled();

    stations.list = [
      {
        id: "01a1d1f5-315c-71fc-9db3-9772cb0dbc4f",
        name: "Pack 3",
        active: true,
        currentUserName: null,
        lastSeenAt: null,
        createdAt: new Date(),
      },
    ];
    await advance(2_000);

    expect(screen.getByText("Pack 3 is set up")).toBeTruthy();
    expect(screen.queryByTestId("setup-code")).toBeNull();
    // The used code leaves the open codes listed behind the dialog.
    expect(invalidated).toHaveBeenCalledWith({ queryKey: setupCodesKey });
    // It stays set up when the time would have run out.
    await advance(600_000);
    expect(screen.getByText("Pack 3 is set up")).toBeTruthy();
  });
});
