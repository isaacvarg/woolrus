"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { NoteTargetInput, NoteVisibility } from "@woolrus/contracts";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Form } from "react-aria-components";
import { Button, Switch, TextAreaField } from "@/components/ui/fields";
import { toast } from "@/components/ui/toast";
import { useErrorMessage, useFieldErrors } from "@/lib/errors";
import { client, orpc } from "@/lib/orpc";
import { PhotoPicker, UploadProgress } from "./photo-picker";
import { type VoiceMemo, VoiceRecorder } from "./voice-recorder";

export const NOTE_MAX_LENGTH = 4000;

/**
 * Internal unless the author may write to the customer (`note.customer`); everyone else never sees
 * the switch, and the server refuses it from them anyway (FR-NOTE-08).
 */
export function VisibilitySwitch({
  value,
  onChange,
}: {
  value: NoteVisibility;
  onChange: (value: NoteVisibility) => void;
}) {
  const t = useTranslations();
  return (
    <div>
      <Switch
        isSelected={value === "CUSTOMER"}
        onChange={(selected) => onChange(selected ? "CUSTOMER" : "INTERNAL")}
      >
        {t("notes.customerVisible")}
      </Switch>
      <p className="text-sm opacity-70">{t("notes.customerVisibleHint")}</p>
    </div>
  );
}

/** Something a note can be on, as the target picker offers it. `label` is already worded. */
export type TargetOption = { target: NoteTargetInput; label: string };

export const targetKey = (target: NoteTargetInput) =>
  target.kind === "order" ? "order" : `${target.kind}:${target.id}`;

/** Lists and the order (its lines' and packages' counts) change with every note. */
export function useRefreshNotes(orderId: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.notes.list.key({ input: { orderId } }) }),
      queryClient.invalidateQueries({ queryKey: orpc.orders.key() }),
    ]);
}

/** Text or at least one file (`errors.notes.empty`). */
export const validateNoteContent = (value: string, fileCount: number) =>
  value.trim() || fileCount > 0 ? null : "errors.notes.empty";

/**
 * Writes a note, with photos and a voice memo, on the order or on one of `targets` (a line, a package…).
 * `initialTarget` presets the picker, e.g. when opened from a line.
 */
export function NoteComposer({
  orderId,
  canWriteCustomer,
  targets = [],
  initialTarget = { kind: "order" },
  onAdded,
}: {
  orderId: string;
  canWriteCustomer: boolean;
  targets?: TargetOption[];
  initialTarget?: NoteTargetInput;
  onAdded?: () => void;
}) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const fieldErrors = useFieldErrors();
  const refresh = useRefreshNotes(orderId);
  const pickerId = useId();
  const [content, setContent] = useState("");
  const [visibility, setVisibility] = useState<NoteVisibility>("INTERNAL");
  const [target, setTarget] = useState(() => targetKey(initialTarget));
  const [photos, setPhotos] = useState<File[]>([]);
  const [voice, setVoice] = useState<VoiceMemo | null>(null);
  const fileCount = photos.length + (voice ? 1 : 0);
  const [progress, setProgress] = useState<number | null>(null);
  // One key per draft: a retry after a dropped response returns the note instead of adding twice.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  const create = useMutation({
    mutationFn: () =>
      client.notes.create(
        {
          idempotencyKey,
          orderId,
          content,
          visibility,
          target: targets.find((o) => targetKey(o.target) === target)?.target ?? { kind: "order" },
          photos,
          ...(voice ? { voice: voice.file, voiceDurationMs: voice.durationMs } : {}),
        },
        fileCount > 0 ? { context: { onUploadProgress: setProgress } } : {},
      ),
    onSuccess: () => {
      setContent("");
      setVisibility("INTERNAL");
      setPhotos([]);
      setVoice(null);
      setIdempotencyKey(crypto.randomUUID());
      toast.success(t("notes.added"));
      onAdded?.();
    },
    onError: (error) => {
      if (Object.keys(fieldErrors(error)).length === 0) toast.error(errorMessage(error));
    },
    onSettled: () => {
      setProgress(null);
      return refresh();
    },
  });

  return (
    <Form
      className="space-y-2 rounded-box bg-base-100 p-4 shadow-sm"
      validationErrors={create.error ? fieldErrors(create.error) : undefined}
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate();
      }}
    >
      <TextAreaField
        label={t("notes.newNote")}
        name="content"
        maxLength={NOTE_MAX_LENGTH}
        validate={(value) => {
          const error = validateNoteContent(value, fileCount);
          return error && t(error);
        }}
        value={content}
        onChange={setContent}
      />
      {targets.length > 1 && (
        <div className="fieldset">
          <label htmlFor={pickerId} className="fieldset-legend">
            {t("notes.on")}
          </label>
          {/* Native on purpose: tablets open their own large picker. */}
          <select
            id={pickerId}
            className="select select-lg w-full"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          >
            {targets.map((option) => (
              <option key={targetKey(option.target)} value={targetKey(option.target)}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      )}
      <PhotoPicker photos={photos} onChange={setPhotos} />
      <VoiceRecorder value={voice} onChange={setVoice} />
      {canWriteCustomer && <VisibilitySwitch value={visibility} onChange={setVisibility} />}
      {progress !== null && <UploadProgress value={progress} />}
      <Button type="submit" className="btn-primary btn-lg" isPending={create.isPending}>
        {t("notes.add")}
      </Button>
    </Form>
  );
}
