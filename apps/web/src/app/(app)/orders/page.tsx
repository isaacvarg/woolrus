import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { OrdersTable } from "./orders-table";

export default async function OrdersPage() {
  const t = await getTranslations();

  return (
    <section className="mx-auto max-w-6xl space-y-6">
      <h1 className="text-3xl font-bold">{t("nav.allOrders")}</h1>
      {/* The table reads its view from the URL query. */}
      <Suspense fallback={<p>{t("common.loading")}</p>}>
        <OrdersTable />
      </Suspense>
    </section>
  );
}
