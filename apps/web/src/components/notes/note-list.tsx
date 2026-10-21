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
import {
  NOTE_MAX_LENGTH,
  useRefreshNotes,
  VisibilitySwitch,
  validateNoteContent,
} from "./note-composer";
import { PhotoGallery } from "./photo-gallery";
import { PhotoPicker, UploadProgress } from "./photo-picker";
import { type VoiceMemo, VoicePlayer, VoiceRecorder } from "./voice-recorder";

const photosOf = (note: Note) => note.attachments.filter((a) => a.kind === "IMAGE");
const voiceOf = (note: Note) => note.attachments.find((a) => a.kind === "VOICE");

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
  const voice = voiceOf(note);

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
      {note.content && <p className="whitespace-pre-line break-words">{note.content}</p>}
      <PhotoGallery photos={photosOf(note)} />
      {voice && <VoicePlayer memo={voice} />}
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

function EditNote({ note, canWriteCustomer }: { note: Note; canWriteCustomer: boolean }) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const fieldErrors = useFieldErrors();
  const refresh = useRefreshNotes(note.orderId);
  const [content, setContent] = useState(note.content);
  const [visibility, setVisibility] = useState<NoteVisibility>(note.visibility);
  const [addPhotos, setAddPhotos] = useState<File[]>([]);
  const [addVoice, setAddVoice] = useState<VoiceMemo | null>(null);
  const [removeIds, setRemoveIds] = useState<string[]>([]);
  const [progress, setProgress] = useState<number | null>(null);
  const kept = note.attachments.filter((a) => !removeIds.includes(a.id));
  const voice = voiceOf(note);
  const voiceRemoved = voice ? removeIds.includes(voice.id) : false;
  const addCount = addPhotos.length + (addVoice ? 1 : 0);

  const update = useMutation({
    mutationFn: () =>
      client.notes.update(
        {
          id: note.id,
          content,
          // Only someone who sees the switch sends it; the server checks it either way.
          ...(canWriteCustomer ? { visibility } : {}),
          addPhotos,
          ...(addVoice ? { addVoice: addVoice.file, voiceDurationMs: addVoice.durationMs } : {}),
          removeAttachmentIds: removeIds,
        },
        addCount > 0 ? { context: { onUploadProgress: setProgress } } : {},
      ),
    onError: (error) => {
      if (Object.keys(fieldErrors(error)).length === 0) toast.error(errorMessage(error));
    },
    onSettled: () => {
      setProgress(null);
      return refresh();
    },
  });

  return (
    <DialogTrigger
      onOpenChange={(open) => {
        if (!open) return;
        setContent(note.content);
        setVisibility(note.visibility);
        setAddPhotos([]);
        setAddVoice(null);
        setRemoveIds([]);
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
              maxLength={NOTE_MAX_LENGTH}
              validate={(value) => {
                const error = validateNoteContent(value, kept.length + addCount);
                return error && t(error);
              }}
              value={content}
              onChange={setContent}
              autoFocus
            />
            {photosOf(note).length > 0 && (
              <ul className="flex flex-wrap gap-2" aria-label={t("notes.photos")}>
                {photosOf(note).map((photo) => {
                  const removed = removeIds.includes(photo.id);
                  return (
                    <li key={photo.id} className="flex flex-col items-center gap-1">
                      {/* biome-ignore lint/performance/noImgElement: auth-checked app route */}
                      <img
                        src={photo.thumbUrl ?? photo.url}
                        alt={photo.fileName}
                        className={`size-20 rounded-box object-cover ${removed ? "opacity-30" : ""}`}
                      />
                      <Button
                        className="btn-ghost btn-sm min-h-12"
                        aria-label={t(removed ? "notes.keepPhoto" : "notes.removePhoto", {
                          name: photo.fileName,
                        })}
                        onPress={() =>
                          setRemoveIds((ids) =>
                            removed ? ids.filter((id) => id !== photo.id) : [...ids, photo.id],
                          )
                        }
                      >
                        {t(removed ? "notes.undoRemove" : "notes.remove")}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
            <PhotoPicker
              photos={addPhotos}
              onChange={setAddPhotos}
              existing={kept.filter((a) => a.kind === "IMAGE").length}
            />
            {voice && (
              <div
                className={`flex flex-wrap items-center gap-2 ${voiceRemoved ? "opacity-30" : ""}`}
              >
                <VoicePlayer memo={voice} />
                <Button
                  className="btn-ghost btn-sm min-h-12"
                  aria-label={t(voiceRemoved ? "notes.keepVoice" : "notes.removeVoice")}
                  onPress={() =>
                    setRemoveIds((ids) =>
                      voiceRemoved ? ids.filter((id) => id !== voice.id) : [...ids, voice.id],
                    )
                  }
                >
                  {t(voiceRemoved ? "notes.undoRemove" : "notes.remove")}
                </Button>
              </div>
            )}
            {/* One memo per note: a new one can go in once the old one is marked for removal. */}
            {(!voice || voiceRemoved) && <VoiceRecorder value={addVoice} onChange={setAddVoice} />}
            {canWriteCustomer && <VisibilitySwitch value={visibility} onChange={setVisibility} />}
            {progress !== null && <UploadProgress value={progress} />}
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
