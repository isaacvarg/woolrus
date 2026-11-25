"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { BoxGroup } from "@woolrus/contracts";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Form } from "react-aria-components";
import { Dialog } from "@/components/ui/dialog";
import { Button, TextField } from "@/components/ui/fields";
import { useErrorMessage } from "@/lib/errors";
import { orpc } from "@/lib/orpc";
import { randomUUID } from "@/lib/uuid";

/**
 * The Boxes page's Groups panel (SPEC-packing A2): groups in picker order with their box counts.
 * Admins add, rename, reorder and delete them; deleting ungroups the boxes.
 */
export function BoxGroupsPanel({ groups, canManage }: { groups: BoxGroup[]; canManage: boolean }) {
  const t = useTranslations("boxes.groups");
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  // `false`: closed; `null`: adding; a group: renaming it.
  const [naming, setNaming] = useState<BoxGroup | null | false>(false);
  const [deleting, setDeleting] = useState<BoxGroup | null>(null);

  // A group change moves boxes (delete) and box changes move counts, so both lists refresh.
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.boxGroups.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.boxes.key() }),
    ]);
  const move = useMutation(
    orpc.boxGroups.move.mutationOptions({
      onSuccess: (list) => {
        queryClient.setQueryData(orpc.boxGroups.list.queryKey(), list);
      },
    }),
  );
  const remove = useMutation(
    orpc.boxGroups.delete.mutationOptions({
      onSuccess: async () => {
        setDeleting(null);
        await refresh();
      },
    }),
  );

  return (
    <section aria-labelledby="box-groups-title" className="rounded-box bg-base-100 p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="box-groups-title" className="text-xl font-semibold">
            {t("title")}
          </h2>
          <p className="text-sm opacity-70">{t("hint")}</p>
        </div>
        {canManage && (
          <Button className="btn-outline btn-sm" onPress={() => setNaming(null)}>
            {t("add")}
          </Button>
        )}
      </div>
      {move.error && (
        <p role="alert" className="text-error">
          {errorMessage(move.error)}
        </p>
      )}
      {groups.length === 0 ? (
        <p className="mt-2 text-sm">{t("empty")}</p>
      ) : (
        <ol className="mt-2 divide-y divide-base-200">
          {groups.map((group, index) => (
            <li
              key={group.id}
              data-testid="box-group"
              className="flex flex-wrap items-center justify-between gap-2 py-2"
            >
              <span>
                <span id={`box-group-${group.id}`} className="font-medium">
                  {group.name}
                </span>{" "}
                <span className="text-sm opacity-70">
                  {t("boxCount", { count: group.boxCount })}
                </span>
              </span>
              {canManage && (
                <span className="whitespace-nowrap">
                  <Button
                    className="btn-ghost btn-sm"
                    aria-describedby={`box-group-${group.id}`}
                    isDisabled={index === 0 || move.isPending}
                    onPress={() => move.mutate({ id: group.id, direction: "up" })}
                  >
                    {t("moveUp")}
                  </Button>
                  <Button
                    className="btn-ghost btn-sm"
                    aria-describedby={`box-group-${group.id}`}
                    isDisabled={index === groups.length - 1 || move.isPending}
                    onPress={() => move.mutate({ id: group.id, direction: "down" })}
                  >
                    {t("moveDown")}
                  </Button>
                  <Button
                    className="btn-ghost btn-sm"
                    aria-describedby={`box-group-${group.id}`}
                    onPress={() => setNaming(group)}
                  >
                    {t("rename")}
                  </Button>
                  <Button
                    className="btn-ghost btn-sm text-error"
                    aria-describedby={`box-group-${group.id}`}
                    onPress={() => {
                      // The mutation is the panel's: clear a failed delete of another group.
                      remove.reset();
                      setDeleting(group);
                    }}
                  >
                    {t("delete")}
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ol>
      )}

      {naming !== false && (
        <GroupNameDialog
          key={naming?.id ?? "new"}
          group={naming}
          onSaved={refresh}
          onClose={() => setNaming(false)}
        />
      )}
      {deleting && (
        <Dialog
          title={t("deleteTitle", { name: deleting.name })}
          isOpen
          onOpenChange={(open) => !open && setDeleting(null)}
        >
          {(close) => (
            <div className="space-y-2">
              <p>{t("deleteHint", { count: deleting.boxCount })}</p>
              {remove.error && (
                <p role="alert" className="text-error">
                  {errorMessage(remove.error)}
                </p>
              )}
              <div className="modal-action">
                <Button className="btn-ghost" onPress={close}>
                  {t("cancel")}
                </Button>
                <Button
                  className="btn-error"
                  isPending={remove.isPending}
                  onPress={() => remove.mutate({ id: deleting.id })}
                >
                  {t("delete")}
                </Button>
              </div>
            </div>
          )}
        </Dialog>
      )}
    </section>
  );
}

/** Adds a group (at the end), or renames `group`. */
function GroupNameDialog({
  group,
  onSaved,
  onClose,
}: {
  group: BoxGroup | null;
  onSaved: () => Promise<unknown>;
  onClose: () => void;
}) {
  const t = useTranslations("boxes.groups");
  const errorMessage = useErrorMessage();
  const [name, setName] = useState(group?.name ?? "");
  // One key per dialog: a retried submit can't create two groups.
  const [idempotencyKey] = useState(() => randomUUID());
  const save = useMutation({
    mutationFn: () =>
      group
        ? orpc.boxGroups.rename.call({ id: group.id, name })
        : orpc.boxGroups.create.call({ idempotencyKey, name }),
    onSuccess: async () => {
      await onSaved();
      onClose();
    },
  });

  return (
    <Dialog
      title={group ? t("renameTitle", { name: group.name }) : t("add")}
      isOpen
      onOpenChange={(open) => !open && onClose()}
    >
      {(close) => (
        <Form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <TextField
            label={t("name")}
            name="name"
            isRequired
            maxLength={60}
            value={name}
            onChange={setName}
          />
          {save.error && (
            <p role="alert" className="text-error">
              {errorMessage(save.error)}
            </p>
          )}
          <div className="modal-action">
            <Button className="btn-ghost" onPress={close}>
              {t("cancel")}
            </Button>
            <Button type="submit" isPending={save.isPending}>
              {t("save")}
            </Button>
          </div>
        </Form>
      )}
    </Dialog>
  );
}
