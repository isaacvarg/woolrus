"use client";

import { ReportRange } from "@woolrus/contracts";
import type { MessageKey } from "@woolrus/i18n";
import type { Route } from "next";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { SelectField, TextField } from "@/components/ui/fields";
import { presetRange, type RangePreset, rangePresets } from "./range";
import { useReportRange } from "./use-report-range";

const tabs = [
  { href: "/reports/throughput", label: "reports.tabs.throughput" },
  { href: "/reports/cycle-time", label: "reports.tabs.cycleTime" },
  { href: "/reports/quality", label: "reports.tabs.quality" },
  { href: "/reports/spend", label: "reports.tabs.spend" },
] as const;

/**
 * The tabs and the shared date range (SPEC-reporting "Shared input"). The range lives in the URL,
 * so a link or a reload shows the same view, and the tabs carry it along.
 */
export function ReportsHeader() {
  const t = useTranslations();
  const format = useFormatter();
  const pathname = usePathname();
  const { view, range, today, search, setView } = useReportRange();
  const problem = ReportRange.safeParse(range).error?.issues[0]?.message;
  const day = (value: string) =>
    format.dateTime(new Date(`${value}T00:00:00Z`), { timeZone: "UTC", dateStyle: "medium" });

  const choose = (preset: RangePreset) =>
    setView(preset === "custom" ? { ...view, preset } : presetRange(preset, today));
  const setDay = (key: "from" | "to", value: string) => {
    // A date input reports "" while a day is half typed; keep the last whole one.
    if (value) setView({ ...view, preset: "custom", [key]: value });
  };

  return (
    <div className="space-y-4">
      <nav aria-label={t("reports.sections")} className="tabs tabs-border">
        {tabs.map(({ href, label }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={href}
              href={`${href}${search}` as Route}
              className={`tab ${active ? "tab-active" : ""}`}
              aria-current={active ? "page" : undefined}
            >
              {t(label)}
            </Link>
          );
        })}
      </nav>
      <div className="flex flex-wrap items-end gap-4">
        <div className="w-48">
          <SelectField
            label={t("reports.range.label")}
            selectedKey={view.preset}
            onSelectionChange={(key) => choose(key as RangePreset)}
            options={rangePresets.map((preset) => ({
              id: preset,
              label: t(`reports.range.${preset}`),
            }))}
          />
        </div>
        {view.preset === "custom" ? (
          <>
            <div className="w-44">
              <TextField
                label={t("reports.range.from")}
                type="date"
                value={view.from}
                onChange={(value) => setDay("from", value)}
              />
            </div>
            <div className="w-44">
              <TextField
                label={t("reports.range.to")}
                type="date"
                value={view.to}
                onChange={(value) => setDay("to", value)}
              />
            </div>
          </>
        ) : (
          <p className="pb-3" data-testid="report-range-days">
            {t("reports.range.days", { from: day(view.from), to: day(view.to) })}
          </p>
        )}
        <p className="pb-3 text-sm text-base-content/70">
          {t("reports.range.timeZone", { zone: range.timeZone })}
        </p>
      </div>
      {problem && (
        <p role="alert" className="text-error">
          {t.has(problem) ? t(problem as MessageKey) : t("errors.field.invalid")}
        </p>
      )}
    </div>
  );
}
