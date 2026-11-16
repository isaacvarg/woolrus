"use client";

import { useQuery } from "@tanstack/react-query";
import type { BatchSuggestion } from "@woolrus/contracts";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/fields";
import { orpc } from "@/lib/orpc";
import { ageParts } from "./age";
import { BatchRefusals, useCreateBatch } from "./pick-together";

// Suggested batches on the Pending queue (SPEC-picking A1, "UI"). The server builds them on every
// read; live order events refetch everything under `pickBatches`, these included. A card only ever
// offers: the picker taps it (A1 decision 4).

export function SuggestedBatches({
  hidden,
  onBeginPicking,
  beginningId,
}: {
  /** While the queue is searched: search finds one order, it doesn't plan a walk. */
  hidden: boolean;
  /** A one-order card begins picking that order the way its queue row does. */
  onBeginPicking: (order: { id: string; version: number }) => void;
  /** The order a Begin Picking is in flight for. */
  beginningId: string | null;
}) {
  const t = useTranslations();
  const query = useQuery({ ...orpc.pickBatches.suggestions.queryOptions(), enabled: !hidden });
  const { create, refused } = useCreateBatch();

  const suggestions = query.data?.suggestions ?? [];
  if (hidden || (suggestions.length === 0 && !refused)) return null;
  const openBatch = query.data?.openBatch ?? null;
  const now = Date.now();

  return (
    <section aria-labelledby="suggested-batches" className="space-y-2">
      <h2 id="suggested-batches" className="text-lg font-semibold">
        {t("queue.suggestions.title")}
      </h2>
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {suggestions.map((suggestion, index) => (
          <li key={suggestion.orders[0]?.id}>
            <SuggestionCard
              suggestion={suggestion}
              label={t("queue.suggestions.card", { index: index + 1 })}
              now={now}
              openBatch={openBatch}
              action={
                suggestion.orders.length === 1 ? (
                  <Button
                    isDisabled={openBatch !== null}
                    isPending={beginningId === suggestion.orders[0]?.id}
                    onPress={() => suggestion.orders[0] && onBeginPicking(suggestion.orders[0])}
                  >
                    {t("queue.beginPicking")}
                  </Button>
                ) : (
                  <Button
                    isDisabled={openBatch !== null}
                    isPending={create.isPending && create.variables === suggestion.orders}
                    onPress={() => create.mutate(suggestion.orders)}
                  >
                    {t("queue.suggestions.pickThese")}
                  </Button>
                )
              }
            />
          </li>
        ))}
      </ul>
      <BatchRefusals refused={refused} />
    </section>
  );
}

function SuggestionCard({
  suggestion,
  label,
  now,
  openBatch,
  action,
}: {
  suggestion: BatchSuggestion;
  label: string;
  now: number;
  openBatch: { id: string; number: number } | null;
  action: React.ReactNode;
}) {
  const t = useTranslations();
  const age = ageParts(suggestion.oldest.orderedAt, now);
  return (
    <article aria-label={label} className="card h-full bg-base-100 shadow-sm">
      <div className="card-body gap-2 p-4">
        <p className="font-semibold">
          {t("queue.suggestions.summary", {
            orders: suggestion.orders.length,
            units: suggestion.units,
            stops: suggestion.stops,
          })}
        </p>
        <p className="text-sm text-base-content/70">
          {t("queue.suggestions.oldest", {
            number: suggestion.oldest.number,
            age: t(`queue.age${age.unit}`, { count: age.count }),
          })}
        </p>
        <p className="text-sm">{suggestion.orders.map((o) => `#${o.number}`).join(" · ")}</p>
        {suggestion.shared.length > 0 && (
          <ul className="text-sm">
            {suggestion.shared.map((product) => (
              <li key={product.key}>
                {t("queue.suggestions.shared", {
                  name: product.name,
                  units: product.units,
                  orders: product.orders,
                })}
              </li>
            ))}
          </ul>
        )}
        <div className="card-actions mt-auto items-center justify-end">
          {openBatch && (
            <Link href={`/pick/batch/${openBatch.id}`} className="link text-sm">
              {t("queue.suggestions.finishFirst", { number: openBatch.number })}
            </Link>
          )}
          {action}
        </div>
      </div>
    </article>
  );
}
