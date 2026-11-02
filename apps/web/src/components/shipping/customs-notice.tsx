"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { orpc } from "@/lib/orpc";

// The International badge and, when a package lacks HS code or origin, the products to fix with a
// link to the editor (SPEC-shipping "Customs"). Shown on the packing and QA screens.

export function CustomsNotice({ orderId }: { orderId: string }) {
  const t = useTranslations();
  const customs = useQuery(orpc.shipping.orderCustoms.queryOptions({ input: { orderId } }));
  if (!customs.data?.international) return null;
  const { missing } = customs.data;
  return (
    <div className="space-y-2" data-testid="customs-notice">
      <span className="badge badge-info badge-lg" data-testid="international-badge">
        {t("customsNotice.international")}
      </span>
      {missing.length > 0 && (
        <div className="alert alert-warning block" role="alert" data-testid="customs-missing">
          <p className="font-semibold">{t("customsNotice.missing")}</p>
          <ul className="list-disc ps-6 text-sm">
            {missing.map((entry) => (
              <li key={entry.package}>
                {t("customsNotice.package", {
                  number: entry.package,
                  products: entry.products.join(", "),
                })}
              </li>
            ))}
          </ul>
          <Link href="/settings/customs" className="link" data-testid="customs-editor-link">
            {t("customsNotice.openEditor")}
          </Link>
        </div>
      )}
    </div>
  );
}
