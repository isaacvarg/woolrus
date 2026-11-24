// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import type { Box, BoxSuggestion } from "@woolrus/contracts";
import { messages } from "@woolrus/i18n";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BoxDialog } from "./box-dialog";

// SPEC-packing A2, criterion 34 (columns and the suggestion; groups come with #228).

const box = (id: string, name: string): Box => ({
  id,
  name,
  lengthIn: 12,
  widthIn: 10,
  heightIn: 8,
  maxWeightOz: null,
  minWeightOz: null,
  tareWeightOz: null,
  outerLengthIn: null,
  outerWidthIn: null,
  outerHeightIn: null,
  barcode: null,
  groupId: null,
  inUse: false,
  archived: false,
});

const small = box("01a1d1f5-315c-71fc-9db3-9772cb0dbc41", "Small mailer");
const medium = box("01a1d1f5-315c-71fc-9db3-9772cb0dbc42", "Medium carton");
const large = box("01a1d1f5-315c-71fc-9db3-9772cb0dbc43", "Large carton");
const suggested: BoxSuggestion = { kind: "box", box: medium, estimatedWeightOz: 38 };

afterEach(cleanup);

function open(columns: 1 | 2, suggestion: BoxSuggestion = suggested) {
  render(
    <NextIntlClientProvider locale="en" messages={messages.en} timeZone="UTC">
      <BoxDialog
        title="Choose a box"
        boxes={[small, medium, large]}
        suggestion={suggestion}
        weightDisplay="LB_OZ"
        columns={columns}
        isPending={false}
        onChoose={vi.fn()}
        onClose={vi.fn()}
      />
    </NextIntlClientProvider>,
  );
}

const grid = () => screen.getByTestId("box-grid");
const button = (name: string) => screen.getByRole("button", { name: new RegExp(name) });

describe("BoxDialog columns (criterion 34)", () => {
  it("uses one column by default", () => {
    open(1);
    expect(grid().className).not.toMatch(/grid-cols-2/);
  });

  it("uses two columns only when the preference is 2, dropping to one on a narrow screen", () => {
    open(2);
    expect(grid().className).toMatch(/(^| )grid-cols-1( |$)/);
    expect(grid().className).toMatch(/min-\[480px\]:grid-cols-2/);
  });
});

describe("BoxDialog suggestion (criterion 34)", () => {
  it("shows the suggested box first, outside the grid, full width with the badge, fit text and border", () => {
    open(2);
    const suggestedButton = button("Medium carton");
    expect(within(grid()).queryByText("Medium carton")).toBeNull();
    // First of all the boxes, and not repeated.
    const boxes = screen.getAllByRole("button", { name: /carton|mailer/ });
    expect(boxes[0]).toBe(suggestedButton);
    expect(boxes).toHaveLength(3);

    expect(suggestedButton.className).toMatch(/w-full/);
    expect(suggestedButton.className).toMatch(/border-2/);
    expect(suggestedButton.className).toMatch(/border-primary/);
    expect(within(suggestedButton).getByText("Suggested")).toBeTruthy();
    expect(within(suggestedButton).getByText(/Fits everything/)).toBeTruthy();
    // The other boxes keep the plain outline.
    expect(button("Small mailer").className).not.toMatch(/border-primary/);
  });

  it("has no highlighted box when the suggestion isn't a box", () => {
    open(2, { kind: "split" });
    expect(within(grid()).getAllByRole("button")).toHaveLength(3);
    expect(screen.queryByText("Suggested")).toBeNull();
  });
});
