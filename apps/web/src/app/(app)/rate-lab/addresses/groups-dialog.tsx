"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LabGroup, RateLabGroupKind } from "@woolrus/contracts";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Form } from "react-aria-components";
import { Dialog } from "@/components/ui/dialog";
import { Button, TextField } from "@/components/ui/fields";
import { useErrorMessage } from "@/lib/errors";
import { orpc } from "@/lib/orpc";

/** Groups of one kind: add, rename and archive. Archived groups drop out of this list and the filters. */
export function GroupsDialog({
  kind = "ADDRESS",
  onClose,
}: {
  kind?: RateLabGroupKind;
  onClose: () => void;
}) {
  const t = useTranslations("rateLab.groups");
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const groups = useQuery(
    orpc.rateLab.groups.queryOptions({ input: { kind, includeArchived: false } }),
  );
  const [name, setName] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [renaming, setRenaming] = useState<LabGroup | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.rateLab.key() });
  const create = useMutation(
    orpc.rateLab.createGroup.mutationOptions({
      onSuccess: async () => {
        setName("");
        setIdempotencyKey(crypto.randomUUID());
        await refresh();
      },
    }),
  );
  const archive = useMutation(orpc.rateLab.archiveGroup.mutationOptions({ onSuccess: refresh }));
  const error = create.error ?? archive.error;

  return (
    <>
      <Dialog
        title={kind === "PARCEL" ? t("parcelTitle") : t("title")}
        isOpen
        onOpenChange={(open) => !open && onClose()}
      >
        {(close) => (
          <div className="space-y-4">
            <Form
              className="flex items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                create.mutate({ idempotencyKey, kind, name });
              }}
            >
              <div className="grow">
                <TextField
                  label={t("name")}
                  name="name"
                  isRequired
                  maxLength={60}
                  value={name}
                  onChange={setName}
                />
              </div>
              <Button type="submit" className="btn-primary mb-1" isPending={create.isPending}>
                {t("add")}
              </Button>
            </Form>
            {error && (
              <p role="alert" className="text-error">
                {errorMessage(error)}
              </p>
            )}
            <ul className="divide-y divide-base-300">
              {groups.data?.length === 0 && <li className="py-2 opacity-70">{t("empty")}</li>}
              {groups.data?.map((group) => (
                <li key={group.id} className="flex items-center gap-2 py-1">
                  <span className="grow">{group.name}</span>
                  <Button className="btn-ghost btn-sm" onPress={() => setRenaming(group)}>
                    {t("rename")}
                  </Button>
                  <Button
                    className="btn-ghost btn-sm"
                    isPending={archive.isPending && archive.variables?.id === group.id}
                    onPress={() => archive.mutate({ id: group.id })}
                  >
                    {t("archive")}
                  </Button>
                </li>
              ))}
            </ul>
            <div className="modal-action">
              <Button className="btn-ghost" onPress={close}>
                {t("close")}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
      {renaming && <RenameDialog group={renaming} onClose={() => setRenaming(null)} />}
    </>
  );
}

function RenameDialog({ group, onClose }: { group: LabGroup; onClose: () => void }) {
  const t = useTranslations("rateLab.groups");
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const [name, setName] = useState(group.name);
  const rename = useMutation(
    orpc.rateLab.renameGroup.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: orpc.rateLab.key() });
        onClose();
      },
    }),
  );
  return (
    <Dialog
      title={t("renameTitle", { name: group.name })}
      isOpen
      onOpenChange={(open) => !open && onClose()}
    >
      {(close) => (
        <Form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            rename.mutate({ id: group.id, name });
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
          {rename.error && (
            <p role="alert" className="text-error">
              {errorMessage(rename.error)}
            </p>
          )}
          <div className="modal-action">
            <Button className="btn-ghost" onPress={close}>
              {t("cancel")}
            </Button>
            <Button type="submit" isPending={rename.isPending}>
              {t("save")}
            </Button>
          </div>
        </Form>
      )}
    </Dialog>
  );
}
