"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type Invitation, Role } from "@woolrus/contracts";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { Form } from "react-aria-components";
import { Dialog } from "@/components/ui/dialog";
import { Button, Checkbox, TextField } from "@/components/ui/fields";
import { Menu, MenuItem } from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import { useErrorMessage, useFieldErrors } from "@/lib/errors";
import { client, orpc } from "@/lib/orpc";

const roles = Role.options;

const statusBadge: Record<Invitation["status"], string> = {
  pending: "badge-info",
  expired: "badge-warning",
  accepted: "badge-success",
  revoked: "badge-ghost",
};

function useInvalidate() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: orpc.invitations.key() });
}

export function InvitationsManager() {
  const t = useTranslations();
  const format = useFormatter();
  const errorMessage = useErrorMessage();
  const invitations = useQuery(orpc.invitations.list.queryOptions());
  const [inviting, setInviting] = useState(false);
  const [revoking, setRevoking] = useState<Invitation | null>(null);
  const invalidate = useInvalidate();
  const resend = useMutation({
    mutationFn: (invitation: Invitation) => client.invitations.resend({ id: invitation.id }),
    onSuccess: (invitation) => toast.success(t("invitations.resent", { email: invitation.email })),
    onError: (error) => toast.error(errorMessage(error)),
    onSettled: invalidate,
  });
  const columns = 6;

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onPress={() => setInviting(true)}>{t("invitations.invite")}</Button>
      </div>
      <div className="overflow-x-auto rounded-box bg-base-100 shadow-sm">
        <table className="table">
          <thead>
            <tr>
              <th>{t("invitations.email")}</th>
              <th>{t("invitations.roles")}</th>
              <th>{t("invitations.status")}</th>
              <th>{t("invitations.expires")}</th>
              <th>{t("invitations.invitedBy")}</th>
              <th>
                <span className="sr-only">{t("invitations.actions")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {invitations.isPending && (
              <tr>
                <td colSpan={columns}>{t("common.loading")}</td>
              </tr>
            )}
            {invitations.error && (
              <tr>
                <td colSpan={columns} className="text-error">
                  {errorMessage(invitations.error)}
                </td>
              </tr>
            )}
            {invitations.data?.length === 0 && (
              <tr>
                <td colSpan={columns}>{t("invitations.none")}</td>
              </tr>
            )}
            {invitations.data?.map((invitation) => {
              const open = invitation.status === "pending" || invitation.status === "expired";
              return (
                <tr key={invitation.id}>
                  <td className="font-medium">{invitation.email}</td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      {invitation.roles.map((role) => (
                        <span key={role} className="badge badge-outline badge-sm">
                          {t(`users.role.${role}`)}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td>
                    <span className={`badge badge-sm ${statusBadge[invitation.status]}`}>
                      {t(`invitations.statuses.${invitation.status}`)}
                    </span>
                  </td>
                  <td>{format.dateTime(invitation.expiresAt, { dateStyle: "medium" })}</td>
                  <td>{invitation.invitedByName ?? "—"}</td>
                  <td className="text-right">
                    {open && (
                      <Menu
                        label={t("invitations.actionsFor", { email: invitation.email })}
                        trigger="⋯"
                      >
                        <MenuItem onAction={() => resend.mutate(invitation)}>
                          {t("invitations.resend")}
                        </MenuItem>
                        <MenuItem danger onAction={() => setRevoking(invitation)}>
                          {t("invitations.revoke")}
                        </MenuItem>
                      </Menu>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {inviting && <InviteDialog onClose={() => setInviting(false)} />}
      {revoking && <RevokeDialog invitation={revoking} onClose={() => setRevoking(null)} />}
    </div>
  );
}

function InviteDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const fieldErrors = useFieldErrors();
  const invalidate = useInvalidate();
  const [email, setEmail] = useState("");
  const [selected, setSelected] = useState(new Set<Role>());
  // One key per dialog: a retried submit (flaky Wi-Fi) can't invite twice.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const create = useMutation({
    mutationFn: () => client.invitations.create({ idempotencyKey, email, roles: [...selected] }),
    onSuccess: (invitation) => {
      toast.success(t("invitations.sent", { email: invitation.email }));
      onClose();
    },
    onSettled: invalidate,
  });
  const errors = fieldErrors(create.error);
  const fieldError = errors.email ?? errors.roles;

  return (
    <Dialog title={t("invitations.inviteTitle")} isOpen onOpenChange={(open) => !open && onClose()}>
      {(close) => (
        <Form
          validationErrors={errors}
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <TextField
            name="email"
            label={t("invitations.email")}
            type="email"
            isRequired
            autoFocus
            value={email}
            onChange={setEmail}
          />
          <fieldset className="fieldset">
            <legend className="fieldset-legend">{t("invitations.roles")}</legend>
            {roles.map((role) => (
              <Checkbox
                key={role}
                isSelected={selected.has(role)}
                onChange={(on) => {
                  const next = new Set(selected);
                  if (on) next.add(role);
                  else next.delete(role);
                  setSelected(next);
                }}
              >
                {t(`users.role.${role}`)}
              </Checkbox>
            ))}
          </fieldset>
          {create.error && !errors.email && (
            <p role="alert" className="text-error">
              {fieldError ?? errorMessage(create.error)}
            </p>
          )}
          <div className="modal-action">
            <Button className="btn-ghost" onPress={close}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" isPending={create.isPending}>
              {t("invitations.send")}
            </Button>
          </div>
        </Form>
      )}
    </Dialog>
  );
}

function RevokeDialog({ invitation, onClose }: { invitation: Invitation; onClose: () => void }) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const invalidate = useInvalidate();
  const revoke = useMutation({
    mutationFn: () => client.invitations.revoke({ id: invitation.id }),
    onSuccess: onClose,
    onSettled: invalidate,
  });

  return (
    <Dialog
      title={t("invitations.revokeTitle", { email: invitation.email })}
      isOpen
      onOpenChange={(open) => !open && onClose()}
    >
      {(close) => (
        <>
          <p>{t("invitations.revokeBody")}</p>
          {revoke.error && (
            <p role="alert" className="text-error">
              {errorMessage(revoke.error)}
            </p>
          )}
          <div className="modal-action">
            <Button className="btn-ghost" onPress={close}>
              {t("common.cancel")}
            </Button>
            <Button
              className="btn-error"
              isPending={revoke.isPending}
              onPress={() => revoke.mutate()}
            >
              {t("invitations.revoke")}
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}
