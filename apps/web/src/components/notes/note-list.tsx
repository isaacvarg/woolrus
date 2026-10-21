"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import type { Note, NoteTarget, NoteTargetKind, NoteVisibility } from "@woolrus/contracts";
import { useFormatter, useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Form, ToggleButton, ToggleButtonGroup } from "react-aria-components";
import { Dialog, DialogTrigger } from "@/components/ui/dialog";
import { Button, TextAreaField } from "@/components/ui/fields";
import { toast } from "@/components/ui/toast";
import { useErrorMessage, useFieldErrors } from "@/lib/errors";
import { client, orpc } from "@/lib/orpc";
import { NOTE_MAX_LENGTH, useRefreshNotes, VisibilitySwitch } from "./note-composer";

const kinds: NoteTargetKind[] = ["order", "item", "package", "issue"];
const filterLabel = {
  order: "notes.filterOrder",
  item: "notes.filterItem",
  package: "notes.filterPackage",
  issue: "notes.filterIssue",
} as const;

/** How a target reads: "Line: Lavender soap ×2". */
export function useTargetName() {
  const t = useTranslations();
  return ({ kind, label }: Pick<NoteTarget, "kind" | "label">) =>
    t(`notes.target.${kind}`, { label });
}

type Group = { target: NoteTarget; notes: Note[] };

/** One group per target: the order first, then lines, packages and issues, each in first-note order. */
function groupByTarget(notes: Note[]): Group[] {
  const groups = new Map<string, Group>();
  for (const note of notes) {
    const key = `${note.target.kind}:${note.target.id}`;
    const group = groups.get(key) ?? { target: note.target, notes: [] };
    group.notes.push(note);
    groups.set(key, group);
  }
  return [...groups.values()].sort(
    (a, b) => kinds.indexOf(a.target.kind) - kinds.indexOf(b.target.kind),
  );
}

/**
 * An order's notes, grouped by what they're on, oldest first within a group, with a filter by
 * target kind. Edit and Delete show only where the server says `canEdit`.
 */
export function NoteList({
  orderId,
  canWriteCustomer,
}: {
  orderId: string;
  canWriteCustomer: boolean;
}) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const targetName = useTargetName();
  const headingId = useId();
  const [filter, setFilter] = useState<NoteTargetKind | "all">("all");
  const notes = useQuery(orpc.notes.list.queryOptions({ input: { orderId } }));

  if (notes.isPending) return <p>{t("common.loading")}</p>;
  if (notes.error) return <p className="text-error">{errorMessage(notes.error)}</p>;
  if (notes.data.length === 0) return <p>{t("notes.empty")}</p>;

  const groups = groupByTarget(notes.data).filter(
    (g) => filter === "all" || g.target.kind === filter,
  );
  return (
    <div className="space-y-3">
      <ToggleButtonGroup
        aria-label={t("notes.filter")}
        selectionMode="single"
        disallowEmptySelection
        selectedKeys={[filter]}
        onSelectionChange={(keys) => {
          const [key] = [...keys];
          if (key) setFilter(key as NoteTargetKind | "all");
        }}
        className="flex flex-wrap gap-2"
      >
        {(["all", ...kinds] as const).map((key) => (
          <ToggleButton
            key={key}
            id={key}
            className={({ isSelected }) =>
              `btn min-h-12 ${isSelected ? "btn-primary" : "btn-outline"}`
            }
          >
            {t(key === "all" ? "notes.filterAll" : filterLabel[key])}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
      {groups.length === 0 && <p>{t("notes.noneInFilter")}</p>}
      {groups.map((group) => (
        <section
          key={`${group.target.kind}:${group.target.id}`}
          aria-labelledby={`${headingId}-${group.target.id}`}
          className="space-y-2"
          data-testid="note-group"
        >
          <h3 id={`${headingId}-${group.target.id}`} className="font-semibold">
            {targetName(group.target)}
          </h3>
          <ol className="space-y-2">
            {group.notes.map((note) => (
              <NoteItem key={note.id} note={note} canWriteCustomer={canWriteCustomer} />
            ))}
          </ol>
        </section>
      ))}
    </div>
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
      {note.canEdit && (
        <div className="flex gap-2">
          <EditNote note={note} canWriteCustomer={canWriteCustomer} />
          <DeleteNote note={note} />
        </div>
      )}
    </li>
  );
}

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
