"use client";

import type { NoteAttachment } from "@woolrus/contracts";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { Button } from "@/components/ui/fields";

/** A horizontal swipe longer than this (px) moves to the next or previous photo. */
const SWIPE = 50;

/**
 * A note's photo thumbnails. Tapping one opens a lightbox with next/previous (buttons, arrow keys
 * or a swipe). Images come from the app's attachment routes, which check access on every fetch.
 */
export function PhotoGallery({ photos }: { photos: NoteAttachment[] }) {
  const t = useTranslations();
  const [open, setOpen] = useState<number | null>(null);
  if (photos.length === 0) return null;

  return (
    <>
      <ul className="flex flex-wrap gap-2" aria-label={t("notes.photos")}>
        {photos.map((photo, index) => (
          <li key={photo.id}>
            <Button
              className="size-20 overflow-hidden rounded-box p-0"
              aria-label={t("notes.openPhoto", { index: index + 1, count: photos.length })}
              onPress={() => setOpen(index)}
            >
              {/* biome-ignore lint/performance/noImgElement: auth-checked app route, not optimizable */}
              <img
                src={photo.thumbUrl ?? photo.url}
                alt=""
                className="size-full object-cover"
                loading="lazy"
              />
            </Button>
          </li>
        ))}
      </ul>
      {open !== null && (
        <Lightbox
          photos={photos}
          index={open}
          onIndexChange={setOpen}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

function Lightbox({
  photos,
  index,
  onIndexChange,
  onClose,
}: {
  photos: NoteAttachment[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}) {
  const t = useTranslations();
  const swipeFrom = useRef<number | null>(null);
  const photo = photos[index];
  const count = photos.length;
  const go = (step: number) => onIndexChange((index + step + count) % count);
  // Arrow keys page through while the lightbox is open (the modal keeps focus inside it).
  const goRef = useRef(go);
  goRef.current = go;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight") goRef.current(1);
      if (event.key === "ArrowLeft") goRef.current(-1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  if (!photo) return null;

  return (
    <ModalOverlay
      isOpen
      isDismissable
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
      className="fixed inset-0 z-50 grid place-items-center bg-black p-2"
    >
      <Modal className="flex h-full w-full flex-col">
        <Dialog className="flex h-full flex-col gap-2 text-white outline-none">
          <div className="flex items-center justify-between gap-2">
            <Heading slot="title" className="truncate">
              {t("notes.photoOf", { index: index + 1, count })}
            </Heading>
            <Button className="btn-ghost min-h-12 text-white" onPress={onClose}>
              {t("notes.closePhoto")}
            </Button>
          </div>
          <div
            className="flex min-h-0 flex-1 touch-pan-y items-center justify-center"
            onPointerDown={(event) => {
              swipeFrom.current = event.clientX;
            }}
            onPointerUp={(event) => {
              const from = swipeFrom.current;
              swipeFrom.current = null;
              if (from === null || count < 2) return;
              const dx = event.clientX - from;
              if (Math.abs(dx) > SWIPE) go(dx < 0 ? 1 : -1);
            }}
          >
            {/* biome-ignore lint/performance/noImgElement: auth-checked app route, not optimizable */}
            <img
              src={photo.url}
              alt={photo.fileName}
              width={photo.width ?? undefined}
              height={photo.height ?? undefined}
              className="max-h-full max-w-full object-contain select-none"
              draggable={false}
            />
          </div>
          {count > 1 && (
            <div className="flex justify-between">
              <Button className="btn-ghost min-h-12 text-white" onPress={() => go(-1)}>
                ‹ {t("notes.previousPhoto")}
              </Button>
              <Button className="btn-ghost min-h-12 text-white" onPress={() => go(1)}>
                {t("notes.nextPhoto")} ›
              </Button>
            </div>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
