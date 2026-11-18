"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";

/**
 * What a report page shows for its query. React Query keeps the previous range's answer as
 * placeholder data even while the query is disabled, so without this an invalid range (the header
 * already says why) would keep showing the last range's figures. They are dropped here, and the
 * previous answer shown while a new range loads is flagged `busy`.
 */
export function reportView<T>(query: UseQueryResult<T>, valid: boolean) {
  return {
    data: valid ? query.data : undefined,
    loading: valid && query.isPending,
    busy: valid && query.isPlaceholderData,
    error: valid ? query.error : null,
  };
}

/** A report's figures: dimmed and `aria-busy` while they are still the previous range's. */
export function ReportBody({ busy, children }: { busy: boolean; children: ReactNode }) {
  return (
    <div
      aria-busy={busy}
      className={busy ? "space-y-6 opacity-60 transition-opacity" : "space-y-6"}
    >
      {children}
    </div>
  );
}
