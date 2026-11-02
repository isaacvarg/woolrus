"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/fields";
import { orpc } from "@/lib/orpc";
import { useLabelPrint } from "./use-label-print";

/** Reprint per label and per order, for Ready and Completed orders (SPEC-shipping "Print"). */
export function OrderLabels({ orderId }: { orderId: string }) {
  const t = useTranslations();
  const labels = useQuery(orpc.shipping.orderPrintableLabels.queryOptions({ input: { orderId } }));
  const print = useLabelPrint();
  if (!labels.data?.length) return null;
  const busy = print.isPending;

  return (
    <section className="space-y-3 rounded-box bg-base-100 p-4 shadow-sm" data-testid="order-labels">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">{t("print.title")}</h2>
        <Button isPending={busy} onPress={() => print.mutate({ orderIds: [orderId] })}>
          {t("print.reprintOrder")}
        </Button>
      </div>
      <ul className="divide-y divide-base-300">
        {labels.data.map((label) => (
          <li key={label.id} className="flex items-center justify-between gap-3 py-2">
            <span>
              {t("print.package", { number: label.packageNumber })}
              <span className="ms-2 opacity-70">
                {label.carrierCode} {label.serviceCode}
                {label.trackingNumber ? ` · ${label.trackingNumber}` : ""}
              </span>
              <span className="badge badge-sm badge-outline ms-2">
                {label.printCount > 0
                  ? t("print.printedTimes", { count: label.printCount })
                  : t("print.notPrinted")}
              </span>
            </span>
            <Button
              className="btn-outline"
              isPending={busy}
              onPress={() => print.mutate({ labelIds: [label.id] })}
            >
              {t("print.reprint")}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
