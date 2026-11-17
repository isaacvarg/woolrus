"use client";

import { useQuery } from "@tanstack/react-query";
import type { BatchSuggestion, WeightDisplay } from "@woolrus/contracts";
import { formatWeight } from "@woolrus/core/format";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/fields";
import { orpc } from "@/lib/orpc";
import { ageParts } from "./age";
import { type BatchOrder, BatchRefusals, useCreateBatch } from "./pick-together";

// Suggested batches on the Pending queue (SPEC-picking A1, "UI"). The server builds them on every
// read; live order events refetch everything under `pickBatches`, these included. A card only ever
// offers: the picker taps it (A1 decision 4).

export function SuggestedBatches({
  hidden,
  onBeginPicking,
  beginningId,
  onSelect,
}: {
  /** While the queue is searched: search finds one order, it doesn't plan a walk. */
  hidden: boolean;
  /** A one-order card begins picking that order the way its queue row does. */
  onBeginPicking: (order: { id: string; version: number }) => void;
  /** The order a Begin Picking is in flight for. */
  beginningId: string | null;
  /** **Select these**: the card's orders replace the queue's ticks, at the versions it was built from. */
  onSelect: (orders: BatchOrder[]) => void;
}) {
  const t = useTranslations();
  const query = useQuery({ ...orpc.pickBatches.suggestions.queryOptions(), enabled: !hidden });
  const { create, refused } = useCreateBatch();
  const settings = useQuery(orpc.settings.public.queryOptions());
  const weightDisplay = settings.data?.weightDisplay ?? "LB_OZ";

  const suggestions = query.data?.suggestions ?? [];
  if (hidden || (suggestions.length === 0 && !refused)) return null;
  const openBatch = query.data?.openBatch ?? null;
  // One tap at a time: a create or Begin picking in flight disables every card. The pending card is
  // matched by its first order, since a live refetch replaces the arrays while the create runs.
  const busy = create.isPending || beginningId !== null;
  const locked = openBatch !== null || busy;
  const creating = (orders: BatchOrder[]) =>
    create.isPending && create.variables?.[0]?.id === orders[0]?.id;
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
              weightDisplay={weightDisplay}
              action={
                suggestion.orders.length === 1 ? (
                  <Button
                    isDisabled={locked}
                    isPending={beginningId === suggestion.orders[0]?.id}
                    onPress={() => suggestion.orders[0] && onBeginPicking(suggestion.orders[0])}
                  >
                    {t("queue.beginPicking")}
                  </Button>
                ) : (
                  <>
                    <Button
                      className="btn-outline"
                      isDisabled={locked}
                      onPress={() => onSelect(suggestion.orders)}
                    >
                      {t("queue.suggestions.selectThese")}
                    </Button>
                    <Button
                      isDisabled={locked}
                      isPending={creating(suggestion.orders)}
                      onPress={() => create.mutate(suggestion.orders)}
                    >
                      {t("queue.suggestions.pickThese")}
                    </Button>
                  </>
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
  weightDisplay,
  action,
}: {
  suggestion: BatchSuggestion;
  label: string;
  now: number;
  openBatch: { id: string; number: number } | null;
  weightDisplay: WeightDisplay;
  action: React.ReactNode;
}) {
  const t = useTranslations();
  const locale = useLocale();
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
        <p className="flex flex-wrap items-center gap-x-2 text-sm" data-testid="suggestion-weight">
          <span>{formatWeight(suggestion.weightOz, weightDisplay, locale)}</span>
          {suggestion.missingWeightCount > 0 && (
            <span className="text-base-content/70">{t("queue.suggestions.weightIncomplete")}</span>
          )}
          {suggestion.overWeight && (
            <span className="badge badge-warning badge-sm">
              {t("queue.suggestions.overWeight")}
            </span>
          )}
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
