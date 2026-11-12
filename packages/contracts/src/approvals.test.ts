import { describe, expect, it } from "vitest";
import { ApprovalInput } from "./approvals";
import { toFieldErrors } from "./base";

const userId = "0199a1c2-0000-7000-8000-000000000001";

describe("ApprovalInput", () => {
  it("takes a tile's user and PIN, or a badge, with a trimmed reason", () => {
    expect(ApprovalInput.parse({ credential: { userId, pin: "482916" }, reason: "  ok " })).toEqual(
      { credential: { userId, pin: "482916" }, reason: "ok" },
    );
    expect(
      ApprovalInput.parse({ credential: { badgeCode: " WRB-ABC " }, reason: "checked" }),
    ).toEqual({ credential: { badgeCode: "WRB-ABC" }, reason: "checked" });
  });

  it("is as loose about the PIN as the lock screen, so a malformed PIN is a wrong PIN", () => {
    expect(
      ApprovalInput.safeParse({ credential: { userId, pin: "12" }, reason: "ok" }).success,
    ).toBe(true);
  });

  it("requires a credential", () => {
    expect(ApprovalInput.safeParse({ credential: {}, reason: "ok" }).success).toBe(false);
    expect(ApprovalInput.safeParse({ reason: "ok" }).success).toBe(false);
  });

  it("requires a reason of 1 to 200 characters, with a translatable field error", () => {
    const credential = { userId, pin: "482916" };
    for (const reason of ["", "   ", "x".repeat(201)]) {
      const result = ApprovalInput.safeParse({ credential, reason });
      expect(result.success).toBe(false);
      expect(toFieldErrors(result.error?.issues ?? [])).toEqual({
        reason: "errors.approval.reasonRequired",
      });
    }
    expect(ApprovalInput.safeParse({ credential, reason: "x".repeat(200) }).success).toBe(true);
  });
});
