"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type IssuedBadge, Role, type UserSummary } from "@woolrus/contracts";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Form, Input, Label, SearchField } from "react-aria-components";
import { Dialog } from "@/components/ui/dialog";
import { Button, Checkbox } from "@/components/ui/fields";
import { Menu, MenuItem } from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import { useErrorMessage, useFieldErrors } from "@/lib/errors";
import { client, orpc } from "@/lib/orpc";
import { AddEmailDialog } from "./add-email-dialog";
import { BadgeDialog, PinDialog } from "./credentials-dialogs";
import { AddStationUserDialog, stationRoles } from "./station-user-dialog";

const allRoles = Role.options;
const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 250;

function useInvalidate() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: orpc.users.key() });
}

export function UsersManager({ currentUserId }: { currentUserId: string }) {
  const t = useTranslations();
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const errorMessage = useErrorMessage();
  const [searchText, setSearchText] = useState("");
  const [search, setSearch] = useState<string | undefined>();
  const [page, setPage] = useState(1);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchText.trim() || undefined);
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchText]);
  const users = useQuery({
    ...orpc.users.list.queryOptions({ input: { search, page, pageSize: PAGE_SIZE } }),
    placeholderData: keepPreviousData,
  });
  const pages = Math.max(1, Math.ceil((users.data?.total ?? 0) / PAGE_SIZE));
  const [editing, setEditing] = useState<UserSummary | null>(null);
  const [deactivating, setDeactivating] = useState<UserSummary | null>(null);
  const [settingPin, setSettingPin] = useState<UserSummary | null>(null);
  const [badge, setBadge] = useState<IssuedBadge | null>(null);
  const [addingStationUser, setAddingStationUser] = useState(false);
  const [addingEmail, setAddingEmail] = useState<UserSummary | null>(null);
  // Clear PIN or Revoke badge that would leave a station-only user no way in, waiting to be confirmed.
  const [lastWayIn, setLastWayIn] = useState<{ user: UserSummary; credential: Credential } | null>(
    null,
  );
  const invalidate = useInvalidate();
  const reactivate = useMutation({
    mutationFn: (user: UserSummary) => client.users.reactivate({ id: user.id }),
    onError: (error) => toast.error(errorMessage(error)),
    onSettled: invalidate,
  });
  const clearPin = useMutation({
    mutationFn: (user: UserSummary) => client.users.clearPin({ id: user.id }),
    onSuccess: (user) => {
      toast.success(t("users.pinCleared", { name: user.name }));
      setLastWayIn(null);
    },
    onError: (error) => toast.error(errorMessage(error)),
    onSettled: invalidate,
  });
  const issueBadge = useMutation({
    mutationFn: (user: UserSummary) => client.users.issueBadge({ id: user.id }),
    onSuccess: setBadge,
    onError: (error) => toast.error(errorMessage(error)),
    onSettled: invalidate,
  });
  const revokeBadge = useMutation({
    mutationFn: (user: UserSummary) => client.users.revokeBadge({ id: user.id }),
    onSuccess: (user) => {
      toast.success(t("users.badgeRevoked", { name: user.name }));
      setLastWayIn(null);
    },
    onError: (error) => toast.error(errorMessage(error)),
    onSettled: invalidate,
  });
  const columns = 7;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <SearchField
          value={searchText}
          onChange={setSearchText}
          className="fieldset w-full max-w-md"
          aria-label={t("users.search")}
        >
          <Label className="sr-only">{t("users.search")}</Label>
          <Input
            className="input w-full"
            placeholder={t("users.searchPlaceholder")}
            // The API rejects longer searches.
            maxLength={100}
          />
        </SearchField>
        <Button onPress={() => setAddingStationUser(true)}>{t("users.addStationUser")}</Button>
      </div>
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
            {users.data?.users.map((user) => (
              <tr key={user.id} className={user.active ? "" : "opacity-60"}>
                <td>
                  <div className="font-medium">{user.name}</div>
                  {user.stationOnly ? (
                    <span className="badge badge-soft badge-sm">{t("users.stationOnly")}</span>
                  ) : (
                    <div className="text-sm opacity-70">{user.email}</div>
                  )}
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
                  <span
                    className={`badge badge-sm ${user.active ? "badge-success" : "badge-ghost"}`}
                  >
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
                  {user.lastActiveAt
                    ? format.relativeTime(user.lastActiveAt, now)
                    : t("users.never")}
                </td>
                <td className="text-right">
                  {user.id !== currentUserId && (
                    <Menu label={t("users.actionsFor", { name: user.name })} trigger="⋯">
                      <MenuItem onAction={() => setEditing(user)}>{t("users.editRoles")}</MenuItem>
                      {user.stationOnly && (
                        <MenuItem onAction={() => setAddingEmail(user)}>
                          {t("users.addEmail")}
                        </MenuItem>
                      )}
                      <MenuItem onAction={() => setSettingPin(user)}>{t("users.setPin")}</MenuItem>
                      {user.hasPin && (
                        <MenuItem
                          onAction={() =>
                            isLastWayIn(user, "pin")
                              ? setLastWayIn({ user, credential: "pin" })
                              : clearPin.mutate(user)
                          }
                        >
                          {t("users.clearPin")}
                        </MenuItem>
                      )}
                      <MenuItem onAction={() => issueBadge.mutate(user)}>
                        {t("users.issueBadge")}
                      </MenuItem>
                      {user.hasBadge && (
                        <MenuItem
                          onAction={() =>
                            isLastWayIn(user, "badge")
                              ? setLastWayIn({ user, credential: "badge" })
                              : revokeBadge.mutate(user)
                          }
                        >
                          {t("users.revokeBadge")}
                        </MenuItem>
                      )}
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
      </div>
      <nav aria-label={t("users.pagination")} className="flex flex-wrap items-center gap-4">
        <Button className="btn-outline" isDisabled={page <= 1} onPress={() => setPage(page - 1)}>
          {t("users.previousPage")}
        </Button>
        <span className="tabular-nums">{t("users.pageOf", { page, pages })}</span>
        <Button
          className="btn-outline"
          isDisabled={page >= pages}
          onPress={() => setPage(page + 1)}
        >
          {t("users.nextPage")}
        </Button>
      </nav>
      {editing && <RolesDialog user={editing} onClose={() => setEditing(null)} />}
      {deactivating && (
        <DeactivateDialog user={deactivating} onClose={() => setDeactivating(null)} />
      )}
      {addingEmail && <AddEmailDialog user={addingEmail} onClose={() => setAddingEmail(null)} />}
      {lastWayIn && (
        <LastWayInDialog
          {...lastWayIn}
          isPending={clearPin.isPending || revokeBadge.isPending}
          onConfirm={() =>
            lastWayIn.credential === "pin"
              ? clearPin.mutate(lastWayIn.user)
              : revokeBadge.mutate(lastWayIn.user)
          }
          onClose={() => setLastWayIn(null)}
        />
      )}
      {settingPin && <PinDialog user={settingPin} onClose={() => setSettingPin(null)} />}
      {badge && <BadgeDialog badge={badge} onClose={() => setBadge(null)} />}
      {addingStationUser && (
        <AddStationUserDialog
          onClose={() => setAddingStationUser(false)}
          onIssueBadge={(user) => issueBadge.mutate(user)}
        />
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
  // Station-only users can't be Admins (SPEC-identity amendment 1, decision 10).
  const roles = user.stationOnly ? stationRoles : allRoles;

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

type Credential = "pin" | "badge";

/**
 * A station-only user unlocks stations with a PIN or a badge and has no other way in (SPEC-identity
 * amendment 1). Removing the only one they hold is allowed, but asked about first.
 */
function isLastWayIn(user: UserSummary, credential: Credential): boolean {
  if (!user.stationOnly) return false;
  return credential === "pin" ? !user.hasBadge : !user.hasPin;
}

const lastWayInText = {
  pin: { title: "users.clearPinTitle", body: "users.clearPinNoWayIn", action: "users.clearPin" },
  badge: {
    title: "users.revokeBadgeTitle",
    body: "users.revokeBadgeNoWayIn",
    action: "users.revokeBadge",
  },
} as const;

function LastWayInDialog({
  user,
  credential,
  isPending,
  onConfirm,
  onClose,
}: {
  user: UserSummary;
  credential: Credential;
  isPending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const t = useTranslations();
  const text = lastWayInText[credential];

  return (
    <Dialog
      title={t(text.title, { name: user.name })}
      isOpen
      onOpenChange={(open) => !open && onClose()}
    >
      {(close) => (
        <>
          <p className="alert alert-warning">{t(text.body, { name: user.name })}</p>
          <div className="modal-action">
            <Button className="btn-ghost" onPress={close}>
              {t("common.cancel")}
            </Button>
            <Button className="btn-error" isPending={isPending} onPress={onConfirm}>
              {t(text.action)}
            </Button>
          </div>
        </>
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
