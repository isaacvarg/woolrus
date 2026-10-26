"use client";

import { useQuery } from "@tanstack/react-query";
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
  const voidCounts = useQuery(orpc.voids.counts.queryOptions());

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
        <Link href="/orders" className={pathname === "/orders" ? "menu-active" : undefined}>
          {t("nav.allOrders")}
        </Link>
      </li>
      <li>
        <Link href="/voids" className={pathname === "/voids" ? "menu-active" : undefined}>
          <span className="grow">{t("nav.voids")}</span>
          <span className="badge badge-sm" data-testid="voids-count">
            {voidCounts.data?.unresolvedOrders ?? "…"}
          </span>
        </Link>
      </li>
    </>
  );
}
