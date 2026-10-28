"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { orpc } from "@/lib/orpc";

const REFRESH_MS = 60_000;

/** The Failed jobs link, with a count badge when any background job has given up. Admins only. */
export function FailedJobsNav() {
  const t = useTranslations("nav");
  const pathname = usePathname();
  const jobs = useQuery(
    orpc.operations.jobs.failed.list.queryOptions({ input: {}, refetchInterval: REFRESH_MS }),
  );
  const total = jobs.data?.total ?? 0;

  return (
    <li>
      <Link href="/jobs" className={pathname === "/jobs" ? "menu-active" : undefined}>
        <span className="grow">{t("failedJobs")}</span>
        {total > 0 && (
          <span className="badge badge-error badge-sm" data-testid="failed-jobs-count">
            {total}
          </span>
        )}
      </Link>
    </li>
  );
}
