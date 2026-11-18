import { describe, expect, it } from "vitest";
import { initialFilters } from "./real-orders-dashboard";

const now = new Date("2026-11-18T12:00:00Z");

describe("initialFilters", () => {
  it("opens on the last 30 days without a range in the URL", () => {
    expect(initialFilters(new URLSearchParams(), now)).toMatchObject({
      from: "2026-10-20",
      to: "2026-11-18",
    });
  });

  it("opens on the range the URL gives, as Reports → Spend links to it", () => {
    expect(initialFilters(new URLSearchParams("from=2026-11-01&to=2026-11-07"), now)).toMatchObject(
      { from: "2026-11-01", to: "2026-11-07", carrierId: "all" },
    );
  });

  it("ignores a malformed day, keeping the default for it", () => {
    expect(initialFilters(new URLSearchParams("from=nope&to=2026-11-07"), now)).toMatchObject({
      from: "2026-10-20",
      to: "2026-11-07",
    });
  });
});
