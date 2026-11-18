"use client";

import { useTranslations } from "next-intl";
import { ExportCsvLink } from "@/components/export-csv-link";
import { presetRange, todayIn } from "../reports/range";
import { useViewerTimeZone } from "../reports/use-report-range";

/**
 * The users export from user admin (SPEC-reporting "CSV exports"). The page has no date range, so
 * the work columns cover the last 30 days in the viewer's zone; Reports exports any range.
 */
export function UsersExportLink() {
  const t = useTranslations("users");
  const { from, to } = presetRange("30d", todayIn(useViewerTimeZone()));
  return (
    <ExportCsvLink path="/api/users/export.csv" params={{ from, to }} label={t("exportCsv")} />
  );
}
