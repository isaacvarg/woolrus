import { describe, expect, it } from "vitest";
import { displayName } from "./people";

describe("displayName", () => {
  it("is the trimmed name when there is one", () => {
    expect(displayName({ name: "  Luis ", email: "luis@example.test" })).toBe("Luis");
  });

  it("falls back to a real email, never to a station-only placeholder", () => {
    expect(displayName({ name: " ", email: "luis@example.test" })).toBe("luis@example.test");
    expect(displayName({ name: "", email: `${crypto.randomUUID()}@station.invalid` })).toBe("");
  });
});
