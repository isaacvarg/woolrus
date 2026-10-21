"use client";

import { useTranslations } from "next-intl";
import { useId } from "react";
import { NoteComposer } from "./note-composer";
import { NoteList } from "./note-list";

/** The order detail page's Notes section: the notes, then the composer. */
export function NotesPanel({
  orderId,
  canWriteCustomer,
}: {
  orderId: string;
  canWriteCustomer: boolean;
}) {
  const t = useTranslations();
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <h2 id={headingId} className="text-xl font-bold">
        {t("notes.title")}
      </h2>
      <NoteList orderId={orderId} canWriteCustomer={canWriteCustomer} />
      <NoteComposer orderId={orderId} canWriteCustomer={canWriteCustomer} />
    </section>
  );
}
