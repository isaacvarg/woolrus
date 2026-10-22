"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useErrorMessage } from "@/lib/errors";
import { orpc } from "@/lib/orpc";
import { SlotLegend } from "./slot-legend";

// **My picks** (SPEC-picking "UI"): the picker's open batch and the orders they're picking, so
// work survives a reload or a change of tablet.

export function MyPicks() {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const picks = useQuery(orpc.picking.myPicks.queryOptions());

  if (picks.isPending) return <p>{t("common.loading")}</p>;
  if (picks.error) {
    return (
      <p role="alert" className="alert alert-error">
        {errorMessage(picks.error)}
      </p>
    );
  }
  const { batch, orders } = picks.data;
  if (!batch && orders.length === 0) {
    return (
      <p className="alert">
        {t("myPicks.empty")}{" "}
        <Link href="/queue/pending" className="link">
          {t("nav.pending")}
        </Link>
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {batch && (
        <section className="space-y-3" aria-labelledby="my-batch">
          <div className="flex flex-wrap items-center gap-3">
            <h2 id="my-batch" className="text-xl font-semibold">
              {t("pickBatch.title", { number: batch.number })}
            </h2>
            <Link href={`/pick/batch/${batch.id}`} className="btn btn-primary ms-auto">
              {t("myPicks.openBatch")}
            </Link>
          </div>
          <SlotLegend batch={batch} />
        </section>
      )}
      {orders.length > 0 && (
        <section className="space-y-3" aria-labelledby="my-orders">
          <h2 id="my-orders" className="text-xl font-semibold">
            {t("myPicks.orders")}
          </h2>
          <ul className="grid gap-2 sm:grid-cols-2">
            {orders.map((order) => (
              <li key={order.id}>
                <Link
                  href={`/pick/${order.id}`}
                  className="card card-border bg-base-100 p-4 shadow-sm hover:bg-base-200"
                >
                  <span className="text-lg font-semibold">#{order.number}</span>
                  <span>{order.customerName}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
