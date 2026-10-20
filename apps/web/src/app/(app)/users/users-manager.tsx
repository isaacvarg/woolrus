"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Role, type UserSummary } from "@woolrus/contracts";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { useState } from "react";
import { Form } from "react-aria-components";
import { Dialog } from "@/components/ui/dialog";
import { Button, Checkbox } from "@/components/ui/fields";
import { Menu, MenuItem } from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import { useErrorMessage, useFieldErrors } from "@/lib/errors";
import { client, orpc } from "@/lib/orpc";

const roles = Role.options;

function useInvalidate() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: orpc.users.key() });
}

export function UsersManager({ currentUserId }: { currentUserId: string }) {
  const t = useTranslations();
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const errorMessage = useErrorMessage();
  const users = useQuery(orpc.users.list.queryOptions());
  const [editing, setEditing] = useState<UserSummary | null>(null);
  const [deactivating, setDeactivating] = useState<UserSummary | null>(null);
  const invalidate = useInvalidate();
  const reactivate = useMutation({
    mutationFn: (user: UserSummary) => client.users.reactivate({ id: user.id }),
    onError: (error) => toast.error(errorMessage(error)),
    onSettled: invalidate,
  });
  const columns = 7;

  return (
    <div className="overflow-x-auto rounded-box bg-base-100 shadow-sm">
      <table className="table">
        <thead>
          <tr>
            <th>{t("users.name")}</th>
            <th>{t("users.roles")}</th>
            <th>{t("users.status")}</th>
            <th>{t("users.pin")}</th>
            <th>{t("users.badge")}</th>
            <th>{t("users.lastActive")}</th>
            <th>
              <span className="sr-only">{t("users.actions")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {users.isPending && (
            <tr>
              <td colSpan={columns}>{t("common.loading")}</td>
            </tr>
          )}
          {users.error && (
            <tr>
              <td colSpan={columns} className="text-error">
                {errorMessage(users.error)}
              </td>
            </tr>
          )}
          {users.data?.map((user) => (
            <tr key={user.id} className={user.active ? "" : "opacity-60"}>
              <td>
                <div className="font-medium">{user.name}</div>
                <div className="text-sm opacity-70">{user.email}</div>
              </td>
              <td>
                <div className="flex flex-wrap gap-1">
                  {user.roles.map((role) => (
                    <span key={role} className="badge badge-outline badge-sm">
                      {t(`users.role.${role}`)}
                    </span>
                  ))}
                </div>
              </td>
              <td>
                <span className={`badge badge-sm ${user.active ? "badge-success" : "badge-ghost"}`}>
                  {user.active ? t("users.active") : t("users.inactive")}
                </span>
              </td>
              <td>
                {user.pinLockedUntil && user.pinLockedUntil > now
                  ? t("users.pinLocked", {
                      time: format.dateTime(user.pinLockedUntil, { timeStyle: "short" }),
                    })
                  : user.hasPin
                    ? t("users.yes")
                    : t("users.no")}
              </td>
              <td>{user.hasBadge ? t("users.yes") : t("users.no")}</td>
              <td>
                {user.lastActiveAt ? format.relativeTime(user.lastActiveAt, now) : t("users.never")}
              </td>
              <td className="text-right">
                {user.id !== currentUserId && (
                  <Menu label={t("users.actionsFor", { name: user.name })} trigger="⋯">
                    <MenuItem onAction={() => setEditing(user)}>{t("users.editRoles")}</MenuItem>
                    {user.active ? (
                      <MenuItem danger onAction={() => setDeactivating(user)}>
                        {t("users.deactivate")}
                      </MenuItem>
                    ) : (
                      <MenuItem onAction={() => reactivate.mutate(user)}>
                        {t("users.reactivate")}
                      </MenuItem>
                    )}
                  </Menu>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing && <RolesDialog user={editing} onClose={() => setEditing(null)} />}
      {deactivating && (
        <DeactivateDialog user={deactivating} onClose={() => setDeactivating(null)} />
      )}
    </div>
  );
}

function RolesDialog({ user, onClose }: { user: UserSummary; onClose: () => void }) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const fieldErrors = useFieldErrors();
  const invalidate = useInvalidate();
  const [selected, setSelected] = useState(new Set(user.roles));
  const update = useMutation({
    mutationFn: () => client.users.updateRoles({ id: user.id, roles: [...selected] }),
    onSuccess: onClose,
    onSettled: invalidate,
  });
  const rolesError = fieldErrors(update.error).roles;

  return (
    <Dialog
      title={t("users.editRolesTitle", { name: user.name })}
      isOpen
      onOpenChange={(open) => !open && onClose()}
    >
      {(close) => (
        <Form
          onSubmit={(event) => {
            event.preventDefault();
            update.mutate();
          }}
        >
          <fieldset className="fieldset">
            <legend className="fieldset-legend">{t("users.roles")}</legend>
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
          {update.error && (
            <p role="alert" className="text-error">
              {rolesError ?? errorMessage(update.error)}
            </p>
          )}
          <div className="modal-action">
            <Button className="btn-ghost" onPress={close}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" isPending={update.isPending}>
              {t("common.save")}
            </Button>
          </div>
        </Form>
      )}
    </Dialog>
  );
}

function DeactivateDialog({ user, onClose }: { user: UserSummary; onClose: () => void }) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const invalidate = useInvalidate();
  const deactivate = useMutation({
    mutationFn: () => client.users.deactivate({ id: user.id }),
    onSuccess: onClose,
    onSettled: invalidate,
  });

  return (
    <Dialog
      title={t("users.deactivateTitle", { name: user.name })}
      isOpen
      onOpenChange={(open) => !open && onClose()}
    >
      {(close) => (
        <>
          <p>{t("users.deactivateBody")}</p>
          {deactivate.error && (
            <p role="alert" className="text-error">
              {errorMessage(deactivate.error)}
            </p>
          )}
          <div className="modal-action">
            <Button className="btn-ghost" onPress={close}>
              {t("common.cancel")}
            </Button>
            <Button
              className="btn-error"
              isPending={deactivate.isPending}
              onPress={() => deactivate.mutate()}
            >
              {t("users.deactivate")}
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}
