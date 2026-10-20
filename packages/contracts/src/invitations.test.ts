import { describe, expect, it } from "vitest";
import { toFieldErrors } from "./base";
import { CreateInvitationInput } from "./invitations";

const idempotencyKey = "invite-0001";

describe("CreateInvitationInput", () => {
  it("trims and lowercases the email and deduplicates roles", () => {
    expect(
      CreateInvitationInput.parse({
        idempotencyKey,
        email: "  Ana@Example.COM ",
        roles: ["PICKER", "PICKER"],
      }),
    ).toEqual({ idempotencyKey, email: "ana@example.com", roles: ["PICKER"] });
  });

  it("needs a valid email and at least one role, with translatable field errors", () => {
    const result = CreateInvitationInput.safeParse({ idempotencyKey, email: "ana", roles: [] });
    expect(toFieldErrors(result.error?.issues ?? [])).toEqual({
      email: "errors.invitations.emailInvalid",
      roles: "errors.users.rolesRequired",
    });
  });
});
