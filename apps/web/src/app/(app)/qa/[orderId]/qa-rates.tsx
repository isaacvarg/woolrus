"use client";

import {
  type QueryClient,
  useIsMutating,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  type QaPackage,
  type QaResult,
  type QaView,
  RateSelectionReason,
} from "@woolrus/contracts";
import { ChevronDown, Truck } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { Button, SelectField, TextField } from "@/components/ui/fields";
import { toast } from "@/components/ui/toast";
import { useErrorMessage } from "@/lib/errors";
import { money } from "@/lib/money";
import { client, orpc } from "@/lib/orpc";
import { hasLiveLabel } from "./live-label";

// The shipping method of one package (SPEC-qa "Rate selection"): QA picks another service.

/** Reason saves of one order, so the rates and Complete QA can wait for them. */
const reasonKey = (orderId: string) => ["qa", "rateReason", orderId];

/**
 * Resolves once no reason save of the order is in flight. Complete QA waits for it: the label
 * copies the reason when it's created, and a note saved on blur races the tap that caused the blur.
 */
export async function reasonSavesSettled(queryClient: QueryClient, orderId: string) {
  while (queryClient.isMutating({ mutationKey: reasonKey(orderId) }) > 0) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

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

/**
 * The package's shipping method: the chosen rate as a chip (or a call to choose one) that opens
 * every rate in a dialog. The reason for a dearer rate stays on the card under the chip.
 */
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
  const [open, setOpen] = useState(false);
  const select = useMutation({
    mutationFn: (rateId: string) => client.qa.selectRate({ packageId: pkg.id, rateId }),
    ...settle,
  });
  const locked = disabled || hasLiveLabel(pkg);
  // A reason being saved is for the selected rate, so the selection holds still until it lands.
  const savingReason = useIsMutating({ mutationKey: reasonKey(orderId) }) > 0;

  if (pkg.rates.length === 0) return <p className="text-sm opacity-70">{t("qa.noRates")}</p>;
  const selected = pkg.rates.find((r) => r.selected);
  return (
    <div className="space-y-2">
      {selected ? (
        <Button
          onPress={() => setOpen(true)}
          aria-label={t("qa.shippingChosen", {
            service: selected.serviceName,
            price: money(format, selected.amountCents),
          })}
          data-testid="qa-rate-chosen"
          data-expired={selected.expired || undefined}
          className={`btn-outline h-auto min-h-12 w-full flex-wrap justify-start gap-x-3 gap-y-1 whitespace-normal py-2 text-start ${
            selected.expired ? "btn-warning" : ""
          }`}
        >
          <Truck className="size-5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 grow wrap-anywhere font-semibold">{selected.serviceName}</span>
          {selected.expired && <span className="badge badge-warning">{t("qa.rateExpired")}</span>}
          <span className="font-bold tabular-nums">{money(format, selected.amountCents)}</span>
          <ChevronDown className="size-4 shrink-0 opacity-70" aria-hidden="true" />
        </Button>
      ) : (
        <Button
          onPress={() => setOpen(true)}
          data-testid="qa-rate-chosen"
          className={`h-auto min-h-12 w-full gap-2 whitespace-normal ${locked ? "btn-outline" : "btn-primary"}`}
        >
          <Truck className="size-5 shrink-0" aria-hidden="true" />
          {t("qa.chooseShipping")}
        </Button>
      )}
      <Dialog title={t("qa.ratesFor", { number: pkg.number })} isOpen={open} onOpenChange={setOpen}>
        {(close) => (
          <>
            <ul className="grid gap-2" aria-label={t("qa.rates")} data-testid="qa-rates">
              {pkg.rates.map((rate) => (
                <li key={rate.id}>
                  <Button
                    isDisabled={
                      locked || rate.expired || rate.quoteOnly || select.isPending || savingReason
                    }
                    onPress={() => {
                      if (rate.selected) return close();
                      select.mutate(rate.id, { onSuccess: () => close() });
                    }}
                    aria-pressed={rate.selected}
                    data-testid="qa-rate"
                    data-selected={rate.selected}
                    className={`h-auto min-h-14 w-full flex-nowrap items-center justify-between gap-3 whitespace-normal rounded-box border-2 px-3 py-2 text-start font-normal ${
                      rate.selected ? "border-primary bg-primary/10" : "border-base-300 bg-base-100"
                    }`}
                  >
                    <span className="min-w-0 grow wrap-anywhere">
                      <span className="block font-semibold">
                        {rate.serviceName}{" "}
                        <span className="font-normal opacity-70">({rate.carrierCode})</span>
                      </span>
                      {rate.deliveryDays !== null && (
                        <span className="block text-sm opacity-70">
                          {t("qa.rateDays", { days: rate.deliveryDays })}
                        </span>
                      )}
                      {(rate.quoteOnly || rate.expired) && (
                        <span className="mt-1 flex flex-wrap gap-1">
                          {rate.quoteOnly && (
                            <span className="badge badge-outline">{t("qa.rateQuoteOnly")}</span>
                          )}
                          {rate.expired && (
                            <span className="badge badge-warning">{t("qa.rateExpired")}</span>
                          )}
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 font-bold tabular-nums">
                      {money(format, rate.amountCents)}
                    </span>
                  </Button>
                </li>
              ))}
            </ul>
            <div className="flex justify-end">
              <Button className="btn-ghost" onPress={close}>
                {t("qa.ratesClose")}
              </Button>
            </div>
          </>
        )}
      </Dialog>
      {selected && !selected.cheapest && !locked && pkg.selectedRate && (
        // Keyed by the rate, so picking another one starts from its (cleared) reason.
        <RateReason
          key={selected.id}
          orderId={orderId}
          packageId={pkg.id}
          rateId={selected.id}
          reason={pkg.selectedRate.reason}
          note={pkg.selectedRate.note}
        />
      )}
    </div>
  );
}

const noReason = "NONE";

/**
 * SPEC-rate-history: why QA picked a rate that isn't the cheapest one that can be bought. Optional,
 * saved on change; Complete QA waits for a save in flight but never needs one.
 */
function RateReason({
  orderId,
  packageId,
  rateId,
  reason,
  note,
}: {
  orderId: string;
  packageId: string;
  rateId: string;
  reason: RateSelectionReason | null;
  note: string | null;
}) {
  const t = useTranslations();
  const settle = useQaRefetch(orderId);
  const [draft, setDraft] = useState(note ?? "");
  const save = useMutation({
    mutationKey: reasonKey(orderId),
    mutationFn: (input: { reason: RateSelectionReason | null; note?: string }) =>
      client.qa.setRateSelectionReason({ packageId, rateId, ...input }),
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
