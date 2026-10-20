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

export const users = {
  list: base
    .route({ method: "GET", path: "/users", tags: ["Users"], summary: "List users" })
    .output(z.array(UserSummary)),

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
};
