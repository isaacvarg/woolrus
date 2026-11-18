// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import type { SlaStage } from "@woolrus/contracts";
import { messages } from "@woolrus/i18n";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it } from "vitest";
import { SlaAlertStrip } from "./sla-alert";

// SPEC-reporting "Home dashboard": a strip above the tiles naming each stage with late orders,
// each count linking to its queue, hidden while nothing is late.

const none: Record<SlaStage, number> = { PENDING: 0, PICKING: 0, PACKING: 0, QA: 0, READY: 0 };

function show(late: Record<SlaStage, number> | undefined, locale: "en" | "es" = "en") {
  return render(
    <NextIntlClientProvider locale={locale} messages={messages[locale]} timeZone="UTC">
      <SlaAlertStrip late={late} />
    </NextIntlClientProvider>,
  );
}

afterEach(cleanup);

describe("SlaAlertStrip", () => {
  it("renders nothing while no order is late, or before the counts load", () => {
    expect(show(none).container.innerHTML).toBe("");
    cleanup();
    expect(show(undefined).container.innerHTML).toBe("");
  });

  it("names each late stage in queue order and links its count to the queue", () => {
    show({ ...none, QA: 1, PACKING: 3 });

    const alert = screen.getByRole("status");
    expect(alert.textContent).toBe("3 in Packing and 1 in QA past SLA");
    const links = within(alert).getAllByRole("link");
    expect(links.map((l) => [l.textContent, l.getAttribute("href")])).toEqual([
      ["3 in Packing", "/queue/packing"],
      ["1 in QA", "/queue/qa"],
    ]);
    // Floor tablet: each link is a full-height touch target.
    for (const link of links) expect(link.className).toMatch(/\bbtn\b/);
  });

  it("lists three or more stages with commas, and one alone", () => {
    show({ ...none, PENDING: 2, PICKING: 1, READY: 4 });
    expect(screen.getByRole("status").textContent).toBe(
      "2 in Pending, 1 in Picking, and 4 in Ready past SLA",
    );
    cleanup();
    show({ ...none, READY: 1 });
    expect(screen.getByRole("status").textContent).toBe("1 in Ready past SLA");
  });

  it("speaks Spanish", () => {
    show({ ...none, PACKING: 3, QA: 1 }, "es");
    expect(screen.getByRole("status").textContent).toBe(
      "3 en empaque y 1 en control de calidad fuera de plazo",
    );
  });
});
