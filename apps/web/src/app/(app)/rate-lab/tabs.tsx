"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";

const tabs = [
  { href: "/rate-lab/runs", label: "rateLab.tabs.runs" },
  { href: "/rate-lab/addresses", label: "rateLab.tabs.addresses" },
  { href: "/rate-lab/parcels", label: "rateLab.tabs.parcels" },
  { href: "/rate-lab/quote", label: "rateLab.tabs.quote" },
  { href: "/rate-lab/trends", label: "rateLab.tabs.trends" },
  { href: "/rate-lab/real-orders", label: "rateLab.tabs.realOrders" },
] as const;

/** Links styled as tabs: each section is its own page, so the browser's back button works. */
export function RateLabTabs({ showRealOrders }: { showRealOrders: boolean }) {
  const t = useTranslations();
  const pathname = usePathname();
  return (
    <nav aria-label={t("rateLab.sections")} className="tabs tabs-border">
      {tabs
        .filter((tab) => showRealOrders || tab.href !== "/rate-lab/real-orders")
        .map(({ href, label }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={href}
              href={href}
              className={`tab ${active ? "tab-active" : ""}`}
              aria-current={active ? "page" : undefined}
            >
              {t(label)}
            </Link>
          );
        })}
    </nav>
  );
}
