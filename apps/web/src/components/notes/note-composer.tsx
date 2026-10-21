"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { NoteVisibility } from "@woolrus/contracts";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Form } from "react-aria-components";
import { Button, Switch, TextAreaField } from "@/components/ui/fields";
import { toast } from "@/components/ui/toast";
import { useErrorMessage, useFieldErrors } from "@/lib/errors";
import { client, orpc } from "@/lib/orpc";
import { PhotoPicker, UploadProgress } from "./photo-picker";

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

/** Text or at least one file (`errors.notes.empty`). */
export const validateNoteContent = (value: string, fileCount: number) =>
  value.trim() || fileCount > 0 ? null : "errors.notes.empty";

/** Writes a note on the order, with photos. */
export function NoteComposer({
  orderId,
  canWriteCustomer,
}: {
  orderId: string;
  canWriteCustomer: boolean;
}) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const fieldErrors = useFieldErrors();
  const queryClient = useQueryClient();
  const [content, setContent] = useState("");
  const [visibility, setVisibility] = useState<NoteVisibility>("INTERNAL");
  const [photos, setPhotos] = useState<File[]>([]);
  const [progress, setProgress] = useState<number | null>(null);
  // One key per draft: a retry after a dropped response returns the note instead of adding twice.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  const create = useMutation({
    mutationFn: () =>
      client.notes.create(
        { idempotencyKey, orderId, content, visibility, photos },
        photos.length > 0 ? { context: { onUploadProgress: setProgress } } : {},
      ),
    onSuccess: () => {
      setContent("");
      setVisibility("INTERNAL");
      setPhotos([]);
      setIdempotencyKey(crypto.randomUUID());
      toast.success(t("notes.added"));
    },
    onError: (error) => {
      if (Object.keys(fieldErrors(error)).length === 0) toast.error(errorMessage(error));
    },
    onSettled: () => {
      setProgress(null);
      return queryClient.invalidateQueries({
        queryKey: orpc.notes.list.key({ input: { orderId } }),
      });
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
          const error = validateNoteContent(value, photos.length);
          return error && t(error);
        }}
        value={content}
        onChange={setContent}
      />
      <PhotoPicker photos={photos} onChange={setPhotos} />
      {canWriteCustomer && <VisibilitySwitch value={visibility} onChange={setVisibility} />}
      {progress !== null && <UploadProgress value={progress} />}
      <Button type="submit" className="btn-primary btn-lg" isPending={create.isPending}>
        {t("notes.add")}
      </Button>
    </Form>
  );
}
