"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Role, USER_LIST_PAGE_MAX, type UserSummary } from "@woolrus/contracts";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Form } from "react-aria-components";
import { Dialog } from "@/components/ui/dialog";
import { Button, Checkbox, TextField } from "@/components/ui/fields";
import { useErrorMessage, useFieldErrors } from "@/lib/errors";
import { client, orpc } from "@/lib/orpc";
import { PinField } from "./credentials-dialogs";

/** Station-only users can't be Admins (SPEC-identity amendment 1, decision 10). */
export const stationRoles = Role.options.filter((role) => role !== "ADMIN");

const NAME_CHECK_DEBOUNCE_MS = 300;

/**
 * The active user who already has `name` (trimmed, any case), if any. Names needn't be unique, so
 * this only feeds a warning (SPEC-identity amendment 1, decision 13). `users.list` matches part of
 * the name; the exact comparison happens here.
 */
function useActiveNamesake(name: string) {
  const [search, setSearch] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSearch(name.trim()), NAME_CHECK_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [name]);
  const users = useQuery({
    ...orpc.users.list.queryOptions({ input: { search, pageSize: USER_LIST_PAGE_MAX } }),
    enabled: search !== "",
  });
  const wanted = search.toLowerCase();
  // Only while the debounced search still matches what's typed, so a stale warning never shows.
  if (!wanted || name.trim().toLowerCase() !== wanted) return undefined;
  return users.data?.users.find((user) => user.active && user.name.trim().toLowerCase() === wanted);
}

/**
 * Add a worker with no email: name, roles and a PIN (SPEC-identity amendment 1). Once created,
 * the dialog offers Issue badge for them, since a badge is the other way onto a station.
 */
export function AddStationUserDialog({
  onClose,
  onIssueBadge,
}: {
  onClose: () => void;
  onIssueBadge: (user: UserSummary) => void;
}) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const fieldErrors = useFieldErrors();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [selected, setSelected] = useState(new Set<Role>());
  const [pin, setPin] = useState("");
  // One key per dialog: a retried submit (flaky Wi-Fi) can't add the same person twice.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const create = useMutation({
    mutationFn: () =>
      client.users.createStationUser({ idempotencyKey, name, roles: [...selected], pin }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: orpc.users.key() }),
  });
  const errors = fieldErrors(create.error);
  const created = create.data;
  const namesake = useActiveNamesake(created ? "" : name);

  return (
    <Dialog
      title={t("users.addStationUserTitle")}
      isOpen
      onOpenChange={(open) => !open && onClose()}
    >
      {(close) =>
        created ? (
          <>
            <p role="status" className="alert alert-success">
              {t("users.stationUserAdded", { name: created.name })}
            </p>
            <div className="modal-action">
              <Button className="btn-ghost" onPress={close}>
                {t("users.close")}
              </Button>
              <Button
                onPress={() => {
                  onIssueBadge(created);
                  close();
                }}
              >
                {t("users.issueBadge")}
              </Button>
            </div>
          </>
        ) : (
          <Form
            validationErrors={errors}
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate();
            }}
          >
            <p className="text-sm opacity-70">{t("users.stationOnlyHelp")}</p>
            <TextField
              name="name"
              label={t("users.name")}
              isRequired
              autoFocus
              maxLength={80}
              value={name}
              onChange={setName}
            />
            <div aria-live="polite">
              {namesake && (
                <p className="alert alert-warning text-sm">
                  {t("users.duplicateNameWarning", { name: namesake.name })}
                </p>
              )}
            </div>
            <fieldset className="fieldset">
              <legend className="fieldset-legend">{t("users.roles")}</legend>
              {stationRoles.map((role) => (
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
            <PinField pin={pin} onChange={setPin} holderName={name.trim()} />
            {create.error && !errors.name && !errors.pin && (
              <p role="alert" className="text-error">
                {errors.roles ?? errorMessage(create.error)}
              </p>
            )}
            <div className="modal-action">
              <Button className="btn-ghost" onPress={close}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" isPending={create.isPending}>
                {t("users.add")}
              </Button>
            </div>
          </Form>
        )
      }
    </Dialog>
  );
}
