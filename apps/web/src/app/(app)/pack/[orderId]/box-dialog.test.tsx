// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import type { Box, BoxGroup, BoxSuggestion } from "@woolrus/contracts";
import { messages } from "@woolrus/i18n";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BoxDialog } from "./box-dialog";

// SPEC-packing A2, criterion 34: columns, the suggestion, and the group sections.

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

function open(
  columns: 1 | 2,
  suggestion: BoxSuggestion = suggested,
  { boxes = [small, medium, large], groups = [] }: { boxes?: Box[]; groups?: BoxGroup[] } = {},
) {
  render(
    <NextIntlClientProvider locale="en" messages={messages.en} timeZone="UTC">
      <BoxDialog
        title="Choose a box"
        boxes={boxes}
        boxGroups={groups}
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

// With no groups there is exactly one grid.
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

describe("BoxDialog groups (criterion 34)", () => {
  const group = (id: string, name: string, position: number): BoxGroup => ({
    id,
    name,
    position,
    boxCount: 0,
  });
  const mailers = group("01a1d1f5-315c-71fc-9db3-9772cb0dbc51", "Mailers", 1);
  const cartons = group("01a1d1f5-315c-71fc-9db3-9772cb0dbc52", "Cartons", 0);
  const pails = group("01a1d1f5-315c-71fc-9db3-9772cb0dbc53", "Pails", 2);
  const flat = box("01a1d1f5-315c-71fc-9db3-9772cb0dbc44", "Flat pack");
  const grouped = [
    { ...small, groupId: mailers.id },
    { ...medium, groupId: cartons.id },
    { ...large, groupId: cartons.id },
    flat,
  ];

  it("shows the suggestion, then the groups in order with a divider, then Other boxes, then Custom size", () => {
    open(2, suggested, { boxes: grouped, groups: [mailers, cartons, pails] });

    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    // Pails has no boxes, so it isn't shown.
    expect(headings).toEqual(["Cartons", "Mailers", "Other boxes", "Custom size"]);

    const sections = screen.getAllByRole("group");
    const [cartonSection, mailerSection, otherSection] = sections;
    expect(
      within(cartonSection as HTMLElement)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual([expect.stringContaining("Large carton")]);
    expect(within(mailerSection as HTMLElement).getByRole("button").textContent).toMatch(
      /Small mailer/,
    );
    expect(within(otherSection as HTMLElement).getByRole("button").textContent).toMatch(
      /Flat pack/,
    );
    for (const section of sections) expect(section.className).toMatch(/border-t/);
    expect(screen.getByRole("group", { name: "Cartons" })).toBe(cartonSection);
    expect(screen.getByRole("group", { name: "Other boxes" })).toBe(otherSection);

    // Top to bottom: the suggested box, the sections, the custom size form.
    const suggestedButton = button("Medium carton");
    const custom = screen.getByRole("heading", { name: "Custom size" });
    const follows = (a: Element, b: Element) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(suggestedButton, cartonSection as HTMLElement)).toBe(true);
    expect(follows(otherSection as HTMLElement, custom)).toBe(true);
    // Each section uses the packer's columns.
    for (const g of screen.getAllByTestId("box-grid")) {
      expect(g.className).toMatch(/min-\[480px\]:grid-cols-2/);
    }
  });

  it("renders no section headings when there are no groups", () => {
    open(1, suggested, { boxes: grouped.map((b) => ({ ...b, groupId: null })) });
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "Custom size",
    ]);
    expect(screen.queryByRole("group")).toBeNull();
    expect(within(grid()).getAllByRole("button")).toHaveLength(3);
  });
});
