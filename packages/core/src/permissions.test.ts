import { describe, expect, it } from "vitest";
import { type Actor, assertCan, can, permissionsFor } from "./permissions";

const actor = (roles: Actor["roles"]): Actor => ({ userId: "u", roles, stationId: null });

describe("permissions", () => {
  it("denies by default", () => {
    expect(can(actor([]), "box.read")).toBe(false);
    expect(() => assertCan(actor([]), "box.read")).toThrowError("errors.forbidden");
  });

  it("combines roles", () => {
    const both = actor(["PICKER", "PACKER"]);
    expect(can(both, "order.pick")).toBe(true);
    expect(can(both, "order.pack")).toBe(true);
    expect(can(both, "label.purchase")).toBe(false);
  });

  it("gives admins everything", () => {
    expect(can(actor(["ADMIN"]), "settings.manage")).toBe(true);
  });

  it("lists permissions without duplicates", () => {
    const list = permissionsFor(["PICKER", "PACKER"]);
    expect(new Set(list).size).toBe(list.length);
  });
});
