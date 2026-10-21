"use client";

import { useTranslations } from "next-intl";

/** "Something was said here": a note icon with the count, nothing when there are none (FR-NOTE-05). */
export function NoteCount({ count, className = "" }: { count: number; className?: string }) {
  const t = useTranslations();
  if (count === 0) return null;
  const label = t("notes.count", { count });
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`badge badge-info badge-sm gap-1 tabular-nums ${className}`}
    >
      <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5" fill="currentColor">
        <path d="M3 1.5A1.5 1.5 0 0 0 1.5 3v10A1.5 1.5 0 0 0 3 14.5h6.4a1.5 1.5 0 0 0 1-.4l3.7-3.7a1.5 1.5 0 0 0 .4-1V3A1.5 1.5 0 0 0 13 1.5H3Zm1.5 4h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1 0-1Zm0 2.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1 0-1Zm0 2.5h3a.5.5 0 0 1 0 1h-3a.5.5 0 0 1 0-1Z" />
      </svg>
      {count}
    </span>
  );
}
