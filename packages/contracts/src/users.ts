import { z } from "zod";
import { base, Id } from "./base";
import { Role } from "./me";

/** A user as admins see them. Has flags for a PIN and badge, never their hashes. */
export const UserSummary = z.object({
  id: Id,
  name: z.string(),
  email: z.string(),
  roles: z.array(Role),
  active: z.boolean(),
  hasPin: z.boolean(),
  hasBadge: z.boolean(),
  pinLockedUntil: z.date().nullable(),
  /** Latest personal-session use or station unlock. */
  lastActiveAt: z.date().nullable(),
});
export type UserSummary = z.infer<typeof UserSummary>;

export const UpdateUserRolesInput = z.object({
  id: Id,
  roles: z
    .array(Role)
    .min(1, "errors.users.rolesRequired")
    .transform((roles) => [...new Set(roles)]),
});
export type UpdateUserRolesInput = z.infer<typeof UpdateUserRolesInput>;

/** All the same digit (000000) or a straight run up or down (123456, 654321). */
function isWeakPin(pin: string): boolean {
  const digits = [...pin].map(Number);
  const steps = new Set(digits.slice(1).map((d, i) => d - (digits[i] as number)));
  return steps.size === 1 && [0, 1, -1].includes([...steps][0] as number);
}

/** SPEC-identity "PIN rules": exactly 6 digits, not trivially guessable. */
export const Pin = z
  .string()
  .regex(/^\d{6}$/, "errors.users.pinFormat")
  .refine((pin) => !isWeakPin(pin), "errors.users.pinWeak");

export const SetPinInput = z.object({ id: Id, pin: Pin });
export type SetPinInput = z.infer<typeof SetPinInput>;

/** A random valid PIN for the admin form's Generate button (shown once, then handed over). */
export function generatePin(): string {
  for (;;) {
    const [n] = crypto.getRandomValues(new Uint32Array(1));
    const pin = String((n as number) % 1_000_000).padStart(6, "0");
    if (!isWeakPin(pin)) return pin;
  }
}

/** The badge code is returned once, by `issueBadge`, with its QR code as SVG for printing. */
export const IssuedBadge = z.object({
  user: UserSummary,
  code: z.string(),
  qrSvg: z.string(),
});
export type IssuedBadge = z.infer<typeof IssuedBadge>;

export const USER_LIST_PAGE_MAX = 100;

export const UserListInput = z.object({
  /** Part of the name or email, any case. */
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(USER_LIST_PAGE_MAX).default(50),
});
export type UserListInput = z.input<typeof UserListInput>;

export const UserListPage = z.object({
  users: z.array(UserSummary),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});
export type UserListPage = z.infer<typeof UserListPage>;

export const users = {
  list: base
    .route({
      method: "GET",
      path: "/users",
      tags: ["Users"],
      summary: "List users: search by name or email, offset paging",
    })
    .input(UserListInput)
    .output(UserListPage),

  updateRoles: base
    .route({
      method: "PUT",
      path: "/users/{id}/roles",
      tags: ["Users"],
      summary: "Replace a user's roles",
    })
    .input(UpdateUserRolesInput)
    .output(UserSummary),

  deactivate: base
    .route({
      method: "POST",
      path: "/users/{id}/deactivate",
      tags: ["Users"],
      summary: "Deactivate a user and sign them out everywhere",
    })
    .input(z.object({ id: Id }))
    .output(UserSummary),

  reactivate: base
    .route({
      method: "POST",
      path: "/users/{id}/reactivate",
      tags: ["Users"],
      summary: "Reactivate a user",
    })
    .input(z.object({ id: Id }))
    .output(UserSummary),

  setPin: base
    .route({ method: "PUT", path: "/users/{id}/pin", tags: ["Users"], summary: "Set a user's PIN" })
    .input(SetPinInput)
    .output(UserSummary),

  clearPin: base
    .route({
      method: "DELETE",
      path: "/users/{id}/pin",
      tags: ["Users"],
      summary: "Clear a user's PIN",
    })
    .input(z.object({ id: Id }))
    .output(UserSummary),

  issueBadge: base
    .route({
      method: "POST",
      path: "/users/{id}/badge",
      tags: ["Users"],
      summary: "Issue a new badge, replacing any old one. The code is returned only here",
    })
    .input(z.object({ id: Id }))
    .output(IssuedBadge),

  revokeBadge: base
    .route({
      method: "DELETE",
      path: "/users/{id}/badge",
      tags: ["Users"],
      summary: "Revoke a user's badge",
    })
    .input(z.object({ id: Id }))
    .output(UserSummary),
};
