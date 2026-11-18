"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { orpc } from "@/lib/orpc";
import { useDuration } from "./orders/[id]/activity-summary";
import { viewerTimeZone } from "./reports/range";
import { Tile } from "./tile";

/**
 * "Shipped today" and "Median cycle time, last 7 days" on the home dashboard, for `report.read`
 * holders only (SPEC-reporting "Home dashboard"). Without it, nothing renders and nothing is read.
 */
export function ReportTiles({ canRead }: { canRead: boolean }) {
  return canRead ? <ReportTileRow /> : null;
}

function ReportTileRow() {
  const t = useTranslations("dashboard.reportTiles");
  const format = useFormatter();
  const duration = useDuration();
  const [timeZone] = useState(viewerTimeZone);
  const data = useQuery(orpc.reports.today.queryOptions({ input: { timeZone } })).data;
  const median = data && (data.medianCycleMs === null ? "—" : duration(data.medianCycleMs));

  return (
    <dl className="grid grid-cols-2 gap-4">
      <Tile
        label={t("shippedToday")}
        value={data ? format.number(data.shippedToday) : "…"}
        hint={
          <Link href="/reports/throughput?range=today" className="link">
            {t("throughputLink")}
          </Link>
        }
        testId="tile-shipped-today"
      />
      <Tile
        label={t("medianCycle")}
        value={median ?? "…"}
        hint={
          <Link href="/reports/cycle-time" className="link">
            {t("cycleTimeLink")}
          </Link>
        }
        testId="tile-median-cycle"
      />
    </dl>
  );
}
