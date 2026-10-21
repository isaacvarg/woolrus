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
