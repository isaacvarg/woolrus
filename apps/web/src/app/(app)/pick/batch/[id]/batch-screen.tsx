"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useErrorMessage } from "@/lib/errors";
import { orpc } from "@/lib/orpc";
import { SlotLegend } from "../../slot-legend";

// The batch screen (SPEC-picking "UI"). For now the slot legend: which order goes in which slot on
// the cart, and whether it is still in the batch. Each live slot opens that order's pick screen.

export function BatchScreen({ batchId }: { batchId: string }) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const batch = useQuery(orpc.pickBatches.get.queryOptions({ input: { id: batchId } }));

  if (batch.isPending) return <p>{t("common.loading")}</p>;
  if (batch.error) {
    return (
      <p role="alert" className="alert alert-error">
        {errorMessage(batch.error)}
      </p>
    );
  }
  const { data } = batch;
  return (
    <section className="mx-auto max-w-5xl space-y-4">
      <header className="space-y-1">
        <h1 className="text-3xl font-bold">{t("pickBatch.title", { number: data.number })}</h1>
        <p className="text-lg">
          {t("pickBatch.summary", {
            name: data.owner.name,
            live: data.members.filter((m) => m.state === "live").length,
            total: data.members.length,
          })}
        </p>
      </header>
      {data.closedAt && <p className="alert">{t("pickBatch.closed")}</p>}
      <h2 className="text-xl font-semibold">{t("pickBatch.slots")}</h2>
      <SlotLegend batch={data} />
    </section>
  );
}
