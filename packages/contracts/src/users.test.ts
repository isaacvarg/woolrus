import { describe, expect, it } from "vitest";
import { toFieldErrors } from "./base";
import {
  CreateStationUserInput,
  generatePin,
  Pin,
  SetPinInput,
  UpdateUserRolesInput,
} from "./users";

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

describe("Pin", () => {
  it.each(["482915", "090817", "135790"])("accepts %s", (pin) => {
    expect(Pin.safeParse(pin).success).toBe(true);
  });

  it.each(["12345", "1234567", "12a456", " 48291"])("needs exactly 6 digits: %s", (pin) => {
    expect(toFieldErrors(SetPinInput.safeParse({ id, pin }).error?.issues ?? [])).toEqual({
      pin: "errors.users.pinFormat",
    });
  });

  it.each(["000000", "777777", "123456", "654321", "456789", "987654"])(
    "rejects all-same and straight runs: %s",
    (pin) => {
      expect(toFieldErrors(SetPinInput.safeParse({ id, pin }).error?.issues ?? [])).toEqual({
        pin: "errors.users.pinWeak",
      });
    },
  );
});

describe("generatePin", () => {
  it("always makes a valid PIN", () => {
    for (let i = 0; i < 500; i++) expect(Pin.safeParse(generatePin()).success).toBe(true);
  });
});

describe("CreateStationUserInput", () => {
  const valid = { idempotencyKey: "key-12345", name: "  Luis ", roles: ["PICKER"], pin: "482915" };

  it("trims the name and deduplicates roles", () => {
    expect(
      CreateStationUserInput.parse({ ...valid, roles: ["PICKER", "PICKER", "QA"] }),
    ).toMatchObject({ name: "Luis", roles: ["PICKER", "QA"] });
  });

  it.each([
    [{ name: "   " }, { name: "errors.field.required" }],
    [{ name: "x".repeat(81) }, { name: "errors.field.tooBig" }],
    [{ roles: [] }, { roles: "errors.users.rolesRequired" }],
    [{ roles: ["PICKER", "ADMIN"] }, { roles: "errors.users.stationOnlyAdmin" }],
    [{ pin: "123456" }, { pin: "errors.users.pinWeak" }],
  ])("rejects %o with a translatable field error", (overrides, errors) => {
    const result = CreateStationUserInput.safeParse({ ...valid, ...overrides });
    expect(result.success).toBe(false);
    expect(toFieldErrors(result.error?.issues ?? [])).toEqual(errors);
  });
});
