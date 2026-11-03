"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  type QaPackage,
  type QaResult,
  type QaView,
  RateSelectionReason,
} from "@woolrus/contracts";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { Button, SelectField, TextField } from "@/components/ui/fields";
import { toast } from "@/components/ui/toast";
import { useErrorMessage } from "@/lib/errors";
import { client, orpc } from "@/lib/orpc";
import { hasLiveLabel } from "./live-label";
import { money } from "./money";

// The carriers' rates table of one package (SPEC-qa "Rate selection"): QA picks another service.

/** Writes that change the screen's rates. They refetch it instead of patching, as the rates change. */
export function useQaRefetch(orderId: string) {
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const viewKey = orpc.qa.screen.queryKey({ input: { orderId } });
  return {
    onSuccess: (result?: QaResult) => {
      if (result) queryClient.setQueryData<QaView>(viewKey, (v) => (v ? { ...v, ...result } : v));
      void queryClient.invalidateQueries({ queryKey: viewKey });
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(error));
      void queryClient.invalidateQueries({ queryKey: viewKey });
    },
  };
}

export function RatesTable({
  orderId,
  pkg,
  disabled,
}: {
  orderId: string;
  pkg: QaPackage;
  disabled: boolean;
}) {
  const t = useTranslations();
  const format = useFormatter();
  const settle = useQaRefetch(orderId);
  const select = useMutation({
    mutationFn: (rateId: string) => client.qa.selectRate({ packageId: pkg.id, rateId }),
    ...settle,
  });
  const locked = disabled || hasLiveLabel(pkg);

  if (pkg.rates.length === 0) return <p className="text-sm opacity-70">{t("qa.noRates")}</p>;
  const selected = pkg.rates.find((r) => r.selected);
  return (
    <>
      <ul className="grid gap-1" aria-label={t("qa.rates")} data-testid="qa-rates">
        {pkg.rates.map((rate) => (
          <li key={rate.id}>
            <Button
              isDisabled={locked || rate.expired || rate.quoteOnly || select.isPending}
              onPress={() => !rate.selected && select.mutate(rate.id)}
              aria-pressed={rate.selected}
              data-testid="qa-rate"
              data-selected={rate.selected}
              className={`flex min-h-12 w-full items-center gap-3 rounded-box border-2 px-3 text-start ${
                rate.selected ? "border-primary bg-primary/10" : "border-base-300"
              }`}
            >
              <span className="grow">
                {rate.serviceName} <span className="opacity-70">({rate.carrierCode})</span>
                {rate.deliveryDays !== null && (
                  <span className="block text-sm opacity-70">
                    {t("qa.rateDays", { days: rate.deliveryDays })}
                  </span>
                )}
                {rate.quoteOnly && (
                  <span className="badge badge-outline ms-2">{t("qa.rateQuoteOnly")}</span>
                )}
                {rate.expired && (
                  <span className="badge badge-warning ms-2">{t("qa.rateExpired")}</span>
                )}
              </span>
              <span className="font-bold">{money(format, rate.amountCents)}</span>
            </Button>
          </li>
        ))}
      </ul>
      {selected && !selected.cheapest && !locked && pkg.selectedRate && (
        // Keyed by the rate, so picking another one starts from its (cleared) reason.
        <RateReason
          key={selected.id}
          orderId={orderId}
          packageId={pkg.id}
          reason={pkg.selectedRate.reason}
          note={pkg.selectedRate.note}
        />
      )}
    </>
  );
}

const noReason = "NONE";

/**
 * SPEC-rate-history: why QA picked a rate that isn't the cheapest one that can be bought. Optional,
 * saved on change, and never blocks Complete QA.
 */
function RateReason({
  orderId,
  packageId,
  reason,
  note,
}: {
  orderId: string;
  packageId: string;
  reason: RateSelectionReason | null;
  note: string | null;
}) {
  const t = useTranslations();
  const settle = useQaRefetch(orderId);
  const [draft, setDraft] = useState(note ?? "");
  const save = useMutation({
    mutationFn: (input: { reason: RateSelectionReason | null; note?: string }) =>
      client.qa.setRateSelectionReason({ packageId, ...input }),
    ...settle,
  });
  const options = [
    { id: noReason, label: t("qa.reasonNone") },
    ...RateSelectionReason.options.map((id) => ({ id, label: t(`qa.reasons.${id}`) })),
  ];
  return (
    <div className="grid gap-1 sm:grid-cols-2" data-testid="qa-rate-reason">
      <SelectField
        label={t("qa.reasonLabel")}
        options={options}
        value={reason ?? noReason}
        isDisabled={save.isPending}
        onChange={(key) => {
          const next = key === noReason || key === null ? null : RateSelectionReason.parse(key);
          if (next === reason) return;
          // The server drops the note with any other reason; so does the field.
          if (next !== "OTHER") setDraft("");
          save.mutate({ reason: next });
        }}
      />
      {reason === "OTHER" && (
        <TextField
          label={t("qa.reasonNote")}
          value={draft}
          onChange={setDraft}
          maxLength={200}
          onBlur={() => {
            const trimmed = draft.trim();
            if (trimmed !== (note ?? "")) {
              save.mutate({ reason: "OTHER", ...(trimmed ? { note: trimmed } : {}) });
            }
          }}
        />
      )}
    </div>
  );
}

/** Re-rates the packages without a live label. */
export function RefreshRatesButton({ orderId, disabled }: { orderId: string; disabled: boolean }) {
  const t = useTranslations();
  const settle = useQaRefetch(orderId);
  const refresh = useMutation({
    mutationFn: () => client.carriers.refreshRates({ orderId }),
    ...settle,
    onSuccess: () => settle.onSuccess(),
  });
  return (
    <Button
      isDisabled={disabled || refresh.isPending}
      onPress={() => refresh.mutate()}
      data-testid="qa-refresh-rates"
      className="btn btn-outline btn-sm"
    >
      {t("qa.refreshRates")}
    </Button>
  );
}
