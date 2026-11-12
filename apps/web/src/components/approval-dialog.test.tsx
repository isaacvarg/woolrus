// @vitest-environment jsdom
import { ORPCError } from "@orpc/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { messages } from "@woolrus/i18n";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalDialog } from "./approval-dialog";

// SPEC-identity A2, success criterion 28: the approval dialog any screen opens.

const maria = { id: "01a1d1f5-315c-71fc-9db3-9772cb0dbc4e", name: "Maria Q", initials: "MQ" };

vi.mock("@/lib/orpc", () => ({
  orpc: {
    approvers: {
      list: {
        queryOptions: ({ input }: { input: { permission: string } }) => ({
          queryKey: ["approvers", input.permission],
          queryFn: async () => [maria],
        }),
      },
    },
  },
}));

afterEach(cleanup);

function open(onApprove: (approval: unknown) => Promise<unknown>) {
  const onOpenChange = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <NextIntlClientProvider locale="en" messages={messages.en} timeZone="UTC">
      <QueryClientProvider client={queryClient}>
        <ApprovalDialog
          isOpen
          onOpenChange={onOpenChange}
          title="Approve packing"
          items={["Box is too small"]}
          permission="order.qa"
          onApprove={onApprove}
        />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  // A person types slower than a scanner's 50 ms burst; `scanner` types the way a HID scanner does.
  return {
    onOpenChange,
    user: userEvent.setup({ delay: 60 }),
    scanner: userEvent.setup({ delay: null }),
  };
}

const badPin = () =>
  new ORPCError("UNAUTHORIZED", { data: { messageKey: "errors.station.badPin" } });

describe("ApprovalDialog (criterion 28)", () => {
  it("shows the title and what's being approved, with the badge input focused on open", async () => {
    open(vi.fn());
    expect(screen.getByRole("heading", { name: "Approve packing" })).toBeTruthy();
    expect(screen.getByText("Box is too small")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Badge")));
  });

  it("a bad PIN shows the error in place and keeps the reason; the dialog stays open", async () => {
    const onApprove = vi.fn().mockRejectedValue(badPin());
    const { onOpenChange, user } = open(onApprove);

    await user.type(screen.getByLabelText("Reason"), "pail is in the large box");
    await user.click(await screen.findByRole("button", { name: /Maria Q/ }));
    await user.type(screen.getByLabelText("PIN for Maria Q"), "111111");

    expect(await screen.findByText("That PIN isn't right.")).toBeTruthy();
    expect((screen.getByLabelText("Reason") as HTMLInputElement).value).toBe(
      "pail is in the large box",
    );
    expect((screen.getByLabelText("PIN for Maria Q") as HTMLInputElement).value).toBe("");
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("success calls onApprove once with the credential and reason, then closes", async () => {
    const onApprove = vi.fn().mockResolvedValue({ ok: true });
    const { onOpenChange, user } = open(onApprove);

    await user.type(screen.getByLabelText("Reason"), "  rate checked ");
    await user.click(await screen.findByRole("button", { name: /Maria Q/ }));
    // The keypad, as on a tablet.
    for (const digit of "482916") await user.click(screen.getByRole("button", { name: digit }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith({
      credential: { userId: maria.id, pin: "482916" },
      reason: "rate checked",
    });
  });

  it("a badge scan submits with { badgeCode }", async () => {
    const onApprove = vi.fn().mockResolvedValue({ ok: true });
    const { user } = open(onApprove);

    await user.type(screen.getByLabelText("Reason"), "checked");
    await user.click(screen.getByLabelText("Badge"));
    await user.keyboard("WRB-MARIA{Enter}"); // A HID scanner types the code and Enter.

    await waitFor(() =>
      expect(onApprove).toHaveBeenCalledWith({
        credential: { badgeCode: "WRB-MARIA" },
        reason: "checked",
      }),
    );
  });

  it("a scan before the reason is held: it asks for the reason, then Enter approves", async () => {
    const onApprove = vi.fn().mockResolvedValue({ ok: true });
    const { onOpenChange, user } = open(onApprove);

    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Badge")));
    await user.keyboard("WRB-MARIA{Enter}");

    expect(await screen.findByText("Give a reason of up to 200 characters.")).toBeTruthy();
    expect(onApprove).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Reason")));

    await user.keyboard("checked{Enter}");
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith({
      credential: { badgeCode: "WRB-MARIA" },
      reason: "checked",
    });
  });

  it("a scan into the reason field approves with the badge and keeps it out of the reason", async () => {
    const onApprove = vi.fn().mockResolvedValue({ ok: true });
    const { onOpenChange, user, scanner } = open(onApprove);

    await user.type(screen.getByLabelText("Reason"), "rate checked");
    await scanner.keyboard("WRB-MARIA{Enter}"); // The reason field still has focus.

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith({
      credential: { badgeCode: "WRB-MARIA" },
      reason: "rate checked",
    });
  });
});
