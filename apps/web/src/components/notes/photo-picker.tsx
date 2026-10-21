"use client";

import { NOTE_FILE_MAX_BYTES, NOTE_MAX_PHOTOS, NOTE_PHOTO_TYPES } from "@woolrus/contracts";
import type { ErrorCode } from "@woolrus/i18n";
import { useTranslations } from "next-intl";
import { useEffect, useMemo } from "react";
import { FileTrigger } from "react-aria-components";
import { Button } from "@/components/ui/fields";
import { toast } from "@/components/ui/toast";

const isPhotoType = (type: string) => (NOTE_PHOTO_TYPES as readonly string[]).includes(type);

/**
 * The quick checks before upload, so a wrong file fails at once instead of after sending 15 MB.
 * The server checks the content again; the browser's type is only a hint.
 */
export function checkPhotos(
  picked: File[],
  alreadyThere: number,
): { accepted: File[]; error: ErrorCode | null } {
  let error: ErrorCode | null = null;
  const accepted: File[] = [];
  for (const file of picked) {
    if (!isPhotoType(file.type)) error = "errors.notes.fileType";
    else if (file.size > NOTE_FILE_MAX_BYTES) error = "errors.notes.fileTooLarge";
    else if (alreadyThere + accepted.length >= NOTE_MAX_PHOTOS)
      error = "errors.notes.tooManyPhotos";
    else accepted.push(file);
  }
  return { accepted, error };
}

/**
 * Add photo: the camera on a tablet (`capture`), or the gallery. Picked photos show as previews
 * that can be taken out again before saving. `existing` counts photos the note already keeps.
 */
export function PhotoPicker({
  photos,
  onChange,
  existing = 0,
}: {
  photos: File[];
  onChange: (photos: File[]) => void;
  existing?: number;
}) {
  const t = useTranslations();
  const add = (list: FileList | null) => {
    const { accepted, error } = checkPhotos([...(list ?? [])], existing + photos.length);
    if (error) toast.error(t(error));
    if (accepted.length > 0) onChange([...photos, ...accepted]);
  };
  const full = existing + photos.length >= NOTE_MAX_PHOTOS;
  const accept = [...NOTE_PHOTO_TYPES];

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <FileTrigger acceptedFileTypes={accept} defaultCamera="environment" onSelect={add}>
          <Button className="btn-outline min-h-12" isDisabled={full}>
            {t("notes.takePhoto")}
          </Button>
        </FileTrigger>
        <FileTrigger acceptedFileTypes={accept} allowsMultiple onSelect={add}>
          <Button className="btn-ghost min-h-12" isDisabled={full}>
            {t("notes.choosePhotos")}
          </Button>
        </FileTrigger>
      </div>
      {photos.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label={t("notes.newPhotos")}>
          {photos.map((photo, index) => (
            <PickedPhoto
              // biome-ignore lint/suspicious/noArrayIndexKey: files have no id; order is stable
              key={index}
              file={photo}
              onRemove={() => onChange(photos.filter((_, i) => i !== index))}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function PickedPhoto({ file, onRemove }: { file: File; onRemove: () => void }) {
  const t = useTranslations();
  const url = useMemo(() => URL.createObjectURL(file), [file]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return (
    <li className="relative">
      {/* biome-ignore lint/performance/noImgElement: a local blob preview, nothing to optimize */}
      <img src={url} alt={file.name} className="size-20 rounded-box object-cover" />
      <Button
        className="btn-circle btn-sm absolute -top-3 -right-3 min-h-12 min-w-12"
        aria-label={t("notes.removePhoto", { name: file.name })}
        onPress={onRemove}
      >
        ×
      </Button>
    </li>
  );
}

/** Shown while files go up; `value` is 0–1. */
export function UploadProgress({ value }: { value: number }) {
  const t = useTranslations();
  return (
    <progress
      className="progress progress-primary w-full"
      value={Math.round(value * 100)}
      max={100}
      aria-label={t("notes.uploading")}
    />
  );
}
