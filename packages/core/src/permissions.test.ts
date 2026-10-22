import { describe, expect, it } from "vitest";
import { type Actor, assertCan, can, permissionsFor, systemActor } from "./permissions";

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

  it("lets only admins resolve external changes", () => {
    expect(can(actor(["ADMIN"]), "order.resolveExternalChange")).toBe(true);
    for (const role of ["PICKER", "PACKER", "QA", "SHIPPER"] as const) {
      expect(can(actor([role]), "order.resolveExternalChange")).toBe(false);
    }
  });

  it("lets Admin, QA and Shipper write to the customer, and everyone write notes", () => {
    for (const role of ["ADMIN", "QA", "SHIPPER"] as const) {
      expect(can(actor([role]), "note.customer")).toBe(true);
    }
    for (const role of ["PICKER", "PACKER"] as const) {
      expect(can(actor([role]), "note.customer")).toBe(false);
      expect(can(actor([role]), "note.write")).toBe(true);
      expect(can(actor([role]), "note.moderate")).toBe(false);
    }
  });

  it("lets only admins manage products", () => {
    expect(can(actor(["ADMIN"]), "product.manage")).toBe(true);
    for (const role of ["PICKER", "PACKER", "QA", "SHIPPER"] as const) {
      expect(can(actor([role]), "product.manage")).toBe(false);
    }
  });

  it("gives the system actor no user and no station", () => {
    expect(systemActor).toMatchObject({ userId: null, stationId: null, system: "store-sync" });
    expect(can(systemActor, "order.cancel")).toBe(true);
  });
});
