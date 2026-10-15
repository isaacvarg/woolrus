"use client";

import { useQuery } from "@tanstack/react-query";
import type { Route } from "next";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { orpc } from "@/lib/orpc";
import { queues } from "@/lib/queues";

/** Queue links with live counts (FR-LIST-01). Counts refresh with the queue queries they share keys with. */
export function QueueNav() {
  const t = useTranslations();
  const pathname = usePathname();
  const counts = useQuery(orpc.orders.counts.queryOptions());

  return (
    <>
      <li className="menu-title">{t("nav.queues")}</li>
      {queues.map((queue) => {
        const href = `/queue/${queue.slug}` as const;
        return (
          <li key={queue.stage}>
            <Link href={href} className={pathname === href ? "menu-active" : undefined}>
              <span className="grow">{t(queue.label)}</span>
              <span className="badge badge-sm">{counts.data?.[queue.stage] ?? "…"}</span>
            </Link>
          </li>
        );
      })}
      <li>
        {/* The page arrives with T15; until then typed routes don't know it. */}
        <Link
          href={"/orders" as Route}
          className={pathname === "/orders" ? "menu-active" : undefined}
        >
          {t("nav.allOrders")}
        </Link>
      </li>
    </>
  );
}
