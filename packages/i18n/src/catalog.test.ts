import { describe, expect, it } from "vitest";
import { messages } from "./index";

function keys(obj: object, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    typeof v === "string" ? [`${prefix}${k}`] : keys(v, `${prefix}${k}.`),
  );
}

describe("message catalogs", () => {
  it("es has exactly the same keys as en", () => {
    expect(keys(messages.es).sort()).toEqual(keys(messages.en).sort());
  });
});
