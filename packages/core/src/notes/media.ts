// The upload pipeline (SPEC-notes "Upload pipeline"): every file is checked and processed before
// anything is written, so a refused upload leaves nothing in storage or the database.
import { NOTE_FILE_MAX_BYTES, NOTE_MAX_PHOTOS } from "@woolrus/contracts";
import sharp from "sharp";
import type { ObjectStorage } from "../adapters/storage/storage";
import { AppError } from "../errors";
import { uuidv7 } from "../ids";

export const NOTE_FILE_LIMITS = {
  /** Per file, raw. */
  fileBytes: NOTE_FILE_MAX_BYTES,
  photosPerNote: NOTE_MAX_PHOTOS,
  /** Refused from the header alone, before decoding (decompression bombs). */
  imagePixels: 40_000_000,
} as const;

const IMAGE_EDGE = 2048;
const THUMB_EDGE = 400;
const WEBP_QUALITY = 80;

/** One object to put in storage. */
export type StoredFile = { key: string; body: Uint8Array; contentType: string };

/** A processed attachment: its row's fields and the objects to upload, keys already known. */
export type PreparedAttachment = {
  id: string;
  kind: "IMAGE" | "VOICE";
  storageKey: string;
  thumbnailKey: string | null;
  contentType: string;
  fileName: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  files: StoredFile[];
};

export const attachmentKey = (noteId: string, attachmentId: string, ext: string) =>
  `notes/${noteId}/${attachmentId}.${ext}`;
export const thumbnailKey = (noteId: string, attachmentId: string) =>
  `notes/${noteId}/${attachmentId}-thumb.webp`;

const fileError = (
  messageKey: "errors.notes.fileTooLarge" | "errors.notes.fileType",
  field: string,
) => new AppError("BAD_REQUEST", messageKey, { [field]: messageKey });

type ImageFormat = "jpeg" | "png" | "webp";

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0) =>
  signature.every((b, i) => bytes[offset + i] === b);
const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

/** By content, never by name or the browser's type: a PDF renamed `.jpg` is still a PDF. */
export function sniffImage(bytes: Uint8Array): ImageFormat | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return "webp";
  return null;
}

/**
 * Checks a photo without decoding its pixels: size, type by magic bytes (and that sharp reads the
 * same format from the header), and pixel count. `field` names the form field for the error.
 */
async function checkPhoto(file: File, field: string): Promise<Uint8Array> {
  if (file.size > NOTE_FILE_LIMITS.fileBytes) throw fileError("errors.notes.fileTooLarge", field);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const format = sniffImage(bytes);
  if (!format) throw fileError("errors.notes.fileType", field);
  const meta = await sharp(bytes)
    .metadata()
    .catch(() => null);
  if (!meta || meta.format !== format || !meta.width || !meta.height) {
    throw fileError("errors.notes.fileType", field);
  }
  if (meta.width * meta.height > NOTE_FILE_LIMITS.imagePixels) {
    throw new AppError("BAD_REQUEST", "errors.notes.imageTooLarge", {
      [field]: "errors.notes.imageTooLarge",
    });
  }
  return bytes;
}

/**
 * FR-NOTE-09: upright (EXIF orientation applied), at most 2048 px on the long edge, WebP, and no
 * metadata at all (tablet cameras write GPS). sharp drops metadata unless asked to keep it.
 */
async function processPhoto(noteId: string, bytes: Uint8Array, fileName: string) {
  const id = uuidv7();
  const image = sharp(bytes, { limitInputPixels: NOTE_FILE_LIMITS.imagePixels }).rotate();
  const inside = (edge: number) =>
    ({ width: edge, height: edge, fit: "inside", withoutEnlargement: true }) as const;
  const full = await image
    .clone()
    .resize(inside(IMAGE_EDGE))
    .webp({ quality: WEBP_QUALITY })
    .toBuffer({ resolveWithObject: true });
  const thumb = await image
    .clone()
    .resize(inside(THUMB_EDGE))
    .webp({ quality: WEBP_QUALITY })
    .toBuffer();
  const storageKey = attachmentKey(noteId, id, "webp");
  const thumbKey = thumbnailKey(noteId, id);
  return {
    id,
    kind: "IMAGE",
    storageKey,
    thumbnailKey: thumbKey,
    contentType: "image/webp",
    fileName: fileName.slice(0, 255),
    sizeBytes: full.data.length,
    width: full.info.width,
    height: full.info.height,
    durationMs: null,
    files: [
      { key: storageKey, body: full.data, contentType: "image/webp" },
      { key: thumbKey, body: thumb, contentType: "image/webp" },
    ],
  } satisfies PreparedAttachment;
}

/**
 * Checks every photo first, then processes them one at a time (sharp holds a decoded image in
 * memory). Throws on the first refused file, before any processing.
 */
export async function preparePhotos(noteId: string, photos: File[]): Promise<PreparedAttachment[]> {
  const checked: { bytes: Uint8Array; name: string }[] = [];
  for (const [index, photo] of photos.entries()) {
    checked.push({ bytes: await checkPhoto(photo, `photos.${index}`), name: photo.name });
  }
  const prepared: PreparedAttachment[] = [];
  for (const { bytes, name } of checked) prepared.push(await processPhoto(noteId, bytes, name));
  return prepared;
}

/** Puts every object; on a failure, deletes what got there and rethrows. */
export async function uploadAll(storage: ObjectStorage, files: StoredFile[]): Promise<void> {
  const done: string[] = [];
  try {
    for (const file of files) {
      await storage.put(file.key, file.body, file.contentType);
      done.push(file.key);
    }
  } catch (error) {
    await discardUploads(storage, done);
    throw error;
  }
}

/** Best effort: whatever this misses is an orphan the daily sweep removes. */
export async function discardUploads(storage: ObjectStorage, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await storage.delete(keys).catch(() => {});
}
