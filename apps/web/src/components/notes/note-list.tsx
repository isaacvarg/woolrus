"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Note, NoteVisibility } from "@woolrus/contracts";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { Form } from "react-aria-components";
import { Dialog, DialogTrigger } from "@/components/ui/dialog";
import { Button, TextAreaField } from "@/components/ui/fields";
import { toast } from "@/components/ui/toast";
import { useErrorMessage, useFieldErrors } from "@/lib/errors";
import { client, orpc } from "@/lib/orpc";
import { NOTE_MAX_LENGTH, VisibilitySwitch } from "./note-composer";

/** An order's notes, oldest first. Edit and Delete show only where the server says `canEdit`. */
export function NoteList({
  orderId,
  canWriteCustomer,
}: {
  orderId: string;
  canWriteCustomer: boolean;
}) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const notes = useQuery(orpc.notes.list.queryOptions({ input: { orderId } }));

  if (notes.isPending) return <p>{t("common.loading")}</p>;
  if (notes.error) return <p className="text-error">{errorMessage(notes.error)}</p>;
  if (notes.data.length === 0) return <p>{t("notes.empty")}</p>;

  return (
    <ol className="space-y-2" aria-label={t("notes.title")}>
      {notes.data.map((note) => (
        <NoteItem key={note.id} note={note} canWriteCustomer={canWriteCustomer} />
      ))}
    </ol>
  );
}

function NoteItem({ note, canWriteCustomer }: { note: Note; canWriteCustomer: boolean }) {
  const t = useTranslations();
  const format = useFormatter();

  return (
    <li className="space-y-1 rounded-box bg-base-100 p-3 shadow-sm" data-testid="note">
      <div className="flex flex-wrap items-center gap-x-2 text-sm opacity-80">
        <span className="font-semibold">{note.authorName ?? t("notes.formerUser")}</span>
        {note.stationName && <span>{t("notes.atStation", { station: note.stationName })}</span>}
        <span>· {format.dateTime(note.createdAt, { dateStyle: "short", timeStyle: "short" })}</span>
        {note.editedAt && <span>· {t("notes.edited")}</span>}
        {note.visibility === "CUSTOMER" && (
          <span className="badge badge-accent">{t("notes.customerBadge")}</span>
        )}
        {note.pushedToWooAt && <span className="badge badge-ghost">{t("notes.sentToWoo")}</span>}
      </div>
      <p className="whitespace-pre-line break-words">{note.content}</p>
      {note.pushedToWooAt && <p className="text-sm opacity-70">{t("notes.frozen")}</p>}
      {note.canEdit && (
        <div className="flex gap-2">
          <EditNote note={note} canWriteCustomer={canWriteCustomer} />
          <DeleteNote note={note} />
        </div>
      )}
    </li>
  );
}

const useRefreshNotes = (orderId: string) => {
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({ queryKey: orpc.notes.list.key({ input: { orderId } }) });
};

function EditNote({ note, canWriteCustomer }: { note: Note; canWriteCustomer: boolean }) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const fieldErrors = useFieldErrors();
  const refresh = useRefreshNotes(note.orderId);
  const [content, setContent] = useState(note.content);
  const [visibility, setVisibility] = useState<NoteVisibility>(note.visibility);

  const update = useMutation({
    mutationFn: () =>
      client.notes.update({
        id: note.id,
        content,
        // Only someone who sees the switch sends it; the server checks it either way.
        ...(canWriteCustomer ? { visibility } : {}),
      }),
    onError: (error) => {
      if (Object.keys(fieldErrors(error)).length === 0) toast.error(errorMessage(error));
    },
    onSettled: refresh,
  });

  return (
    <DialogTrigger
      onOpenChange={(open) => {
        if (!open) return;
        setContent(note.content);
        setVisibility(note.visibility);
        update.reset();
      }}
    >
      <Button className="btn-ghost min-h-12">{t("notes.edit")}</Button>
      <Dialog title={t("notes.editTitle")}>
        {(close) => (
          <Form
            className="space-y-2"
            validationErrors={update.error ? fieldErrors(update.error) : undefined}
            onSubmit={(event) => {
              event.preventDefault();
              update.mutateAsync().then(
                () => {
                  toast.success(t("notes.saved"));
                  close();
                },
                () => {},
              );
            }}
          >
            <TextAreaField
              label={t("notes.content")}
              name="content"
              isRequired
              maxLength={NOTE_MAX_LENGTH}
              validate={(value) => (value.trim() ? null : t("errors.notes.empty"))}
              value={content}
              onChange={setContent}
              autoFocus
            />
            {canWriteCustomer && <VisibilitySwitch value={visibility} onChange={setVisibility} />}
            <div className="modal-action">
              <Button className="btn-ghost" onPress={close}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" className="btn-primary" isPending={update.isPending}>
                {t("common.save")}
              </Button>
            </div>
          </Form>
        )}
      </Dialog>
    </DialogTrigger>
  );
}

function DeleteNote({ note }: { note: Note }) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const refresh = useRefreshNotes(note.orderId);
  const remove = useMutation({
    mutationFn: () => client.notes.delete({ id: note.id }),
    onError: (error) => toast.error(errorMessage(error)),
    onSettled: refresh,
  });

  return (
    <DialogTrigger>
      <Button className="btn-ghost min-h-12 text-error">{t("notes.delete")}</Button>
      <Dialog title={t("notes.deleteTitle")}>
        {(close) => (
          <>
            <p>{t("notes.deleteBody")}</p>
            <div className="modal-action">
              <Button className="btn-ghost" onPress={close}>
                {t("common.cancel")}
              </Button>
              <Button
                className="btn-error"
                isPending={remove.isPending}
                onPress={() =>
                  remove.mutateAsync().then(
                    () => {
                      toast.success(t("notes.deleted"));
                      close();
                    },
                    () => {},
                  )
                }
              >
                {t("notes.delete")}
              </Button>
            </div>
          </>
        )}
      </Dialog>
    </DialogTrigger>
  );
}
