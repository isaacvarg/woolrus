import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "../adapters/storage/memory";
import { NOTE_FILE_LIMITS, preparePhotos, sniffImage, uploadAll } from "./media";
import { cameraJpeg, fileOf, solidImage } from "./test-files";

const NOTE_ID = "0192f0a0-0000-7000-8000-000000000001";

const refused = (files: File[], messageKey: string) =>
  expect(preparePhotos(NOTE_ID, files)).rejects.toMatchObject({ kind: "BAD_REQUEST", messageKey });

describe("preparePhotos", () => {
  it("stores a camera JPEG upright, at most 2048 px, as WebP without EXIF or GPS, plus a thumbnail", async () => {
    // 4000×3000 sensor, EXIF orientation 6 (rotate 90° clockwise): the red left half becomes the top.
    const source = await cameraJpeg();
    const sourceMeta = await sharp(source).metadata();
    expect(sourceMeta).toMatchObject({ width: 4000, height: 3000, orientation: 6 });
    expect(sourceMeta.exif).toBeDefined();

    const [photo] = await preparePhotos(NOTE_ID, [fileOf(source, "IMG_0001.jpg")]);
    if (!photo) throw new Error("no photo");

    expect(photo).toMatchObject({
      kind: "IMAGE",
      contentType: "image/webp",
      fileName: "IMG_0001.jpg",
      storageKey: `notes/${NOTE_ID}/${photo.id}.webp`,
      thumbnailKey: `notes/${NOTE_ID}/${photo.id}-thumb.webp`,
      width: 1536,
      height: 2048,
      durationMs: null,
    });
    const [full, thumb] = photo.files;
    if (!full || !thumb) throw new Error("missing files");
    expect(full.key).toBe(photo.storageKey);
    expect(photo.sizeBytes).toBe(full.body.length);

    const stored = await sharp(full.body).metadata();
    expect(stored).toMatchObject({ format: "webp", width: 1536, height: 2048 });
    expect(stored.exif).toBeUndefined();
    expect(stored.orientation).toBeUndefined();
    expect(stored.xmp).toBeUndefined();
    expect(stored.icc).toBeUndefined();

    // Upright: the top is red, the bottom blue.
    const pixel = async (top: number) => {
      const { data } = await sharp(full.body)
        .extract({ left: 768, top, width: 1, height: 1 })
        .raw()
        .toBuffer({ resolveWithObject: true });
      return [...data.subarray(0, 3)];
    };
    const [r1, , b1] = await pixel(100);
    const [r2, , b2] = await pixel(1948);
    expect(r1).toBeGreaterThan(200);
    expect(b1).toBeLessThan(50);
    expect(b2).toBeGreaterThan(200);
    expect(r2).toBeLessThan(50);

    expect(await sharp(thumb.body).metadata()).toMatchObject({
      format: "webp",
      width: 300,
      height: 400,
    });
  });

  it("never enlarges a small photo, and accepts PNG and WebP", async () => {
    const png = await solidImage(640, 480, "png");
    const webp = await solidImage(300, 200, "webp");
    const [a, b] = await preparePhotos(NOTE_ID, [fileOf(png, "a.png"), fileOf(webp, "b.webp")]);
    expect(a).toMatchObject({ width: 640, height: 480, contentType: "image/webp" });
    expect(b).toMatchObject({ width: 300, height: 200 });
    expect(new Set([a?.id, b?.id]).size).toBe(2);
  });

  it("refuses a file over 15 MB", async () => {
    const big = new Uint8Array(NOTE_FILE_LIMITS.fileBytes + 1);
    big.set([0xff, 0xd8, 0xff]);
    await refused([fileOf(big, "big.jpg")], "errors.notes.fileTooLarge");
  });

  it.each([
    ["a PDF renamed .jpg", "%PDF-1.7\n1 0 obj", "scan.jpg"],
    ["an SVG", '<svg xmlns="http://www.w3.org/2000/svg"></svg>', "logo.svg"],
    ["a GIF", "GIF89a\x01\x00\x01\x00", "anim.gif"],
    ["a HEIC", "\x00\x00\x00\x18ftypheic\x00\x00\x00\x00", "IMG.heic"],
    ["a truncated JPEG", "\xff\xd8\xff\xe0", "broken.jpg"],
  ])("refuses %s by its content", async (_, content, name) => {
    const bytes = Uint8Array.from(content, (c) => c.charCodeAt(0));
    await refused([fileOf(bytes, name, "image/jpeg")], "errors.notes.fileType");
  });

  it("refuses an image over 40 megapixels from its header", async () => {
    const huge = await solidImage(8000, 5001, "png");
    await refused([fileOf(huge, "huge.png")], "errors.notes.imageTooLarge");
  });

  it("names the refused file's field", async () => {
    const ok = await solidImage(10, 10, "png");
    const pdf = new TextEncoder().encode("%PDF-1.7");
    await expect(
      preparePhotos(NOTE_ID, [fileOf(ok, "ok.png"), fileOf(pdf, "x.jpg")]),
    ).rejects.toMatchObject({ fields: { "photos.1": "errors.notes.fileType" } });
  });
});

describe("sniffImage", () => {
  it("reads the magic bytes", async () => {
    expect(sniffImage(await solidImage(2, 2, "jpeg"))).toBe("jpeg");
    expect(sniffImage(await solidImage(2, 2, "png"))).toBe("png");
    expect(sniffImage(await solidImage(2, 2, "webp"))).toBe("webp");
    expect(sniffImage(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe("uploadAll", () => {
  it("deletes what it uploaded when a later put fails", async () => {
    const storage = createMemoryStorage();
    const failing = {
      ...storage,
      put: async (key: string, body: Uint8Array, type: string) => {
        if (key === "c") throw new Error("down");
        await storage.put(key, body, type);
      },
    };
    const file = (key: string) => ({ key, body: new Uint8Array([1]), contentType: "x/y" });
    await expect(uploadAll(failing, [file("a"), file("b"), file("c")])).rejects.toThrow("down");
    expect(storage.keys()).toEqual([]);
  });
});
