import { describe, expect, it } from "vitest";
import { pickOrder } from "./sort";

const line = (id: string, fields: { bin?: string | null; name?: string; sku?: string | null }) => ({
  id,
  binLocation: fields.bin ?? null,
  name: fields.name ?? "Soap",
  sku: fields.sku ?? null,
});

const ids = (lines: { id: string }[]) => lines.map((l) => l.id);

describe("pickOrder", () => {
  it("sorts bins in natural order, so A2 comes before A10", () => {
    const sorted = pickOrder([
      line("a10", { bin: "A10" }),
      line("a2", { bin: "A2" }),
      line("b1", { bin: "B1" }),
    ]);
    expect(ids(sorted)).toEqual(["a2", "a10", "b1"]);
  });

  it("puts lines without a bin after those with one", () => {
    const sorted = pickOrder([
      line("none", { name: "Aloe" }),
      line("bin", { bin: "Z9", name: "Zinc" }),
    ]);
    expect(ids(sorted)).toEqual(["bin", "none"]);
  });

  it("orders by name, case-insensitively, when bins are equal or missing", () => {
    const sorted = pickOrder([
      line("b", { name: "beeswax" }),
      line("a", { name: "Aloe" }),
      line("c", { name: "Clay" }),
    ]);
    expect(ids(sorted)).toEqual(["a", "b", "c"]);
  });

  it("breaks name ties by SKU, then by id", () => {
    const sorted = pickOrder([
      line("2", { name: "Soap", sku: "S-2" }),
      line("1b", { name: "Soap", sku: "S-1" }),
      line("1a", { name: "Soap", sku: "S-1" }),
    ]);
    expect(ids(sorted)).toEqual(["1a", "1b", "2"]);
  });

  it("doesn't change the input", () => {
    const input = [line("b", { name: "B" }), line("a", { name: "A" })];
    pickOrder(input);
    expect(ids(input)).toEqual(["b", "a"]);
  });
});
