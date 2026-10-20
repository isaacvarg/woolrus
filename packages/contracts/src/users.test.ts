import { describe, expect, it } from "vitest";
import { toFieldErrors } from "./base";
import { UpdateUserRolesInput } from "./users";

const id = "0199a1c2-0000-7000-8000-000000000001";

describe("UpdateUserRolesInput", () => {
  it("deduplicates roles", () => {
    expect(UpdateUserRolesInput.parse({ id, roles: ["PICKER", "PICKER", "QA"] }).roles).toEqual([
      "PICKER",
      "QA",
    ]);
  });

  it("requires at least one role, with a translatable field error", () => {
    const result = UpdateUserRolesInput.safeParse({ id, roles: [] });
    expect(result.success).toBe(false);
    expect(toFieldErrors(result.error?.issues ?? [])).toEqual({
      roles: "errors.users.rolesRequired",
    });
  });

  it("rejects unknown roles", () => {
    expect(UpdateUserRolesInput.safeParse({ id, roles: ["OWNER"] }).success).toBe(false);
  });
});
