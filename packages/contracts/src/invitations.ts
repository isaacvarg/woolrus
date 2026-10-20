import { z } from "zod";
import { base, Id, IdempotencyKey } from "./base";
import { Role } from "./me";

/** Derived from the timestamps, never stored (SPEC-identity "Invitations"). */
export const InvitationStatus = z.enum(["pending", "expired", "accepted", "revoked"]);
export type InvitationStatus = z.infer<typeof InvitationStatus>;

export const Invitation = z.object({
  id: Id,
  email: z.string(),
  roles: z.array(Role),
  status: InvitationStatus,
  invitedByName: z.string().nullable(),
  expiresAt: z.date(),
  createdAt: z.date(),
});
export type Invitation = z.infer<typeof Invitation>;

export const CreateInvitationInput = z.object({
  idempotencyKey: IdempotencyKey,
  email: z.string().trim().toLowerCase().pipe(z.email("errors.invitations.emailInvalid")),
  roles: z
    .array(Role)
    .min(1, "errors.users.rolesRequired")
    .transform((roles) => [...new Set(roles)]),
});
export type CreateInvitationInput = z.infer<typeof CreateInvitationInput>;

export const invitations = {
  list: base
    .route({
      method: "GET",
      path: "/invitations",
      tags: ["Invitations"],
      summary: "List invitations",
    })
    .output(z.array(Invitation)),

  create: base
    .route({
      method: "POST",
      path: "/invitations",
      tags: ["Invitations"],
      summary: "Invite an email address with roles, and email them",
    })
    .input(CreateInvitationInput)
    .output(Invitation),

  resend: base
    .route({
      method: "POST",
      path: "/invitations/{id}/resend",
      tags: ["Invitations"],
      summary: "Email an invitation again and extend its expiry",
    })
    .input(z.object({ id: Id }))
    .output(Invitation),

  revoke: base
    .route({
      method: "DELETE",
      path: "/invitations/{id}",
      tags: ["Invitations"],
      summary: "Revoke an invitation",
    })
    .input(z.object({ id: Id }))
    .output(Invitation),
};
