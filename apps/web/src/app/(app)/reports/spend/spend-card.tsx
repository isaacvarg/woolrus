"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useReportRange } from "../use-report-range";

/** Real orders on the same days; it reads `from`/`to` from its URL. */
export function SpendCard() {
  const t = useTranslations("reports.spend");
  const { range } = useReportRange();
  const query = new URLSearchParams({ from: range.from, to: range.to });

  return (
    <div className="card bg-base-100 shadow-sm">
      <div className="card-body">
        <h2 className="card-title">{t("title")}</h2>
        <p>{t("body")}</p>
        <div className="card-actions">
          <Link className="btn btn-primary" href={`/rate-lab/real-orders?${query}`}>
            {t("open")}
          </Link>
        </div>
      </div>
    </div>
  );
}
