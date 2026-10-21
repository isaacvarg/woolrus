// Image fixtures for the notes tests, made with sharp so no binaries are checked in.
import sharp from "sharp";

export const fileOf = (bytes: Uint8Array, name: string, type = "") =>
  new File([bytes as Uint8Array<ArrayBuffer>], name, { type });

export async function solidImage(
  width: number,
  height: number,
  format: "jpeg" | "png" | "webp",
): Promise<Uint8Array> {
  return sharp({ create: { width, height, channels: 3, background: "#808080" } })
    .toFormat(format)
    .toBuffer();
}

/**
 * What a tablet camera writes: 4000×3000 stored sideways with EXIF orientation 6, and GPS tags.
 * The left half is red and the right half blue, so upright output has red on top.
 */
export async function cameraJpeg(): Promise<Uint8Array> {
  const half = await sharp({
    create: { width: 2000, height: 3000, channels: 3, background: "#ff0000" },
  })
    .png()
    .toBuffer();
  return sharp({ create: { width: 4000, height: 3000, channels: 3, background: "#0000ff" } })
    .composite([{ input: half, left: 0, top: 0 }])
    .withExif({
      IFD0: { Make: "Tablet", Model: "Camera" },
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: "40/1 26/1 46/1", GPSLongitudeRef: "W" },
    })
    .withMetadata({ orientation: 6 })
    .jpeg({ quality: 70 })
    .toBuffer();
}

/** The first bytes of each audio container the server takes, padded to `size`. */
const AUDIO_HEADERS = {
  webm: [0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01],
  ogg: [..."OggS"].map((c) => c.charCodeAt(0)).concat([0x00, 0x02]),
  m4a: [0x00, 0x00, 0x00, 0x1c, ...[..."ftypM4A "].map((c) => c.charCodeAt(0))],
  mp4: [0x00, 0x00, 0x00, 0x20, ...[..."ftypiso5"].map((c) => c.charCodeAt(0))],
  mp3: [..."ID3"].map((c) => c.charCodeAt(0)).concat([0x04, 0x00]),
  mp3Frame: [0xff, 0xfb, 0x90, 0x64],
} as const;

export function audioBytes(format: keyof typeof AUDIO_HEADERS, size = 4096): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(AUDIO_HEADERS[format]);
  return bytes;
}
