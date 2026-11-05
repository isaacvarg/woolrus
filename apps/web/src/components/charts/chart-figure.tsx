"use client";

import { useTranslations } from "next-intl";
import { type ReactNode, type Ref, useId, useState } from "react";
import { Button } from "@/components/ui/fields";

/**
 * A chart with its caption and the same figures as a table. The SVG is hidden from screen
 * readers, which always read the table; sighted users show it with the button, and print shows it.
 */
export function ChartFigure({
  title,
  headingRef,
  note,
  height = 240,
  chart,
  table,
}: {
  title: string;
  /** For moving focus to the chart (its heading takes focus programmatically only). */
  headingRef?: Ref<HTMLHeadingElement>;
  note?: string;
  height?: number;
  chart: ReactNode;
  table: ReactNode;
}) {
  const t = useTranslations("charts");
  const [showTable, setShowTable] = useState(false);
  const tableId = useId();
  const titleId = useId();
  return (
    // The caption isn't the figure's direct child (it shares a row with the button), so name it.
    <figure aria-labelledby={titleId} className="space-y-2 rounded-box bg-base-100 p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 id={titleId} ref={headingRef} tabIndex={-1} className="font-semibold outline-none">
          {title}
        </h2>
        <Button
          className="btn-ghost btn-xs print:hidden"
          aria-expanded={showTable}
          aria-controls={tableId}
          onPress={() => setShowTable((shown) => !shown)}
        >
          {t(showTable ? "hideData" : "showData")}
        </Button>
      </div>
      {note && <p className="text-sm opacity-70">{note}</p>}
      <div aria-hidden="true" style={{ height }}>
        {chart}
      </div>
      {/* Printed reports always carry the table: some figures (every lane, exact amounts) are only
          there, and a PDF has no button to show them. */}
      <div
        id={tableId}
        className={`${showTable ? "overflow-x-auto" : "sr-only print:not-sr-only"} print:overflow-visible print:[&_table]:table-fixed print:[&_table]:break-words print:[&_th]:whitespace-normal`}
      >
        {table}
      </div>
    </figure>
  );
}
