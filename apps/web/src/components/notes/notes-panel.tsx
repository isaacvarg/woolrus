"use client";

import type { NoteTargetInput } from "@woolrus/contracts";
import { useTranslations } from "next-intl";
import { useId } from "react";
import { Dialog, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/fields";
import { NoteComposer, type TargetOption } from "./note-composer";
import { NoteCount } from "./note-count";
import { NoteList } from "./note-list";

/** The order detail page's Notes section: the notes, then the composer. */
export function NotesPanel({
  orderId,
  canWriteCustomer,
  targets,
}: {
  orderId: string;
  canWriteCustomer: boolean;
  /** What the composer's picker offers besides the order. */
  targets?: TargetOption[];
}) {
  const t = useTranslations();
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <h2 id={headingId} className="text-xl font-bold">
        {t("notes.title")}
      </h2>
      <NoteList orderId={orderId} canWriteCustomer={canWriteCustomer} />
      <NoteComposer orderId={orderId} canWriteCustomer={canWriteCustomer} targets={targets} />
    </section>
  );
}

/**
 * A line's or package's note indicator, and a button that opens the composer preset to it
 * (FR-NOTE-05).
 */
export function NoteOnTarget({
  orderId,
  canWriteCustomer,
  targets,
  target,
  name,
  count,
}: {
  orderId: string;
  canWriteCustomer: boolean;
  targets: TargetOption[];
  target: NoteTargetInput;
  /** The target as worded in the picker, e.g. "Line: Lavender soap ×2". */
  name: string;
  count: number;
}) {
  const t = useTranslations();
  return (
    <span className="inline-flex items-center gap-1">
      <NoteCount count={count} />
      <DialogTrigger>
        <Button
          className="btn-ghost btn-square min-h-12 min-w-12"
          aria-label={t("notes.addOn", { target: name })}
        >
          <svg aria-hidden="true" viewBox="0 0 16 16" className="size-5" fill="currentColor">
            <path d="M8 2a.75.75 0 0 1 .75.75v4.5h4.5a.75.75 0 0 1 0 1.5h-4.5v4.5a.75.75 0 0 1-1.5 0v-4.5h-4.5a.75.75 0 0 1 0-1.5h4.5v-4.5A.75.75 0 0 1 8 2Z" />
          </svg>
        </Button>
        <Dialog title={t("notes.addOn", { target: name })}>
          {(close) => (
            <NoteComposer
              orderId={orderId}
              canWriteCustomer={canWriteCustomer}
              targets={targets}
              initialTarget={target}
              onAdded={close}
            />
          )}
        </Dialog>
      </DialogTrigger>
    </span>
  );
}
