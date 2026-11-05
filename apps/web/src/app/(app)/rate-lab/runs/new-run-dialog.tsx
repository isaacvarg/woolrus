"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LabRunSelection } from "@woolrus/contracts";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { Button, Checkbox } from "@/components/ui/fields";
import { useErrorMessage } from "@/lib/errors";
import { orpc } from "@/lib/orpc";

type Key = keyof LabRunSelection;

/**
 * Picks address and parcel groups or items for a suite run (nothing picked on a side = all of it)
 * and shows the live combination count; over the cap, the count is red and the run can't start.
 */
export function NewRunDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslations("rateLab.runs");
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const [selection, setSelection] = useState<LabRunSelection>({
    addressGroupIds: [],
    addressIds: [],
    parcelGroupIds: [],
    parcelIds: [],
  });
  // One key per dialog: a retried start can't queue two runs.
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const active = { includeArchived: false } as const;
  const addressGroups = useQuery(
    orpc.rateLab.groups.queryOptions({ input: { kind: "ADDRESS", ...active } }),
  );
  const parcelGroups = useQuery(
    orpc.rateLab.groups.queryOptions({ input: { kind: "PARCEL", ...active } }),
  );
  const addresses = useQuery(orpc.rateLab.addresses.queryOptions({ input: {} }));
  const parcels = useQuery(orpc.rateLab.parcels.queryOptions({ input: {} }));
  const preview = useQuery({
    ...orpc.rateLab.previewRun.queryOptions({ input: { selection } }),
    placeholderData: (previous) => previous,
    // Always fresh on open: an admin may have just changed the cap.
    staleTime: 0,
  });

  const start = useMutation(
    orpc.rateLab.startRun.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: orpc.rateLab.runs.key() });
        onClose();
      },
    }),
  );

  const toggle = (key: Key, id: string, on: boolean) => {
    // A refusal was about the old selection; the new one gets its own answer.
    start.reset();
    setSelection((current) => ({
      ...current,
      [key]: on ? [...current[key], id] : current[key].filter((x) => x !== id),
    }));
  };
  /** `options` undefined: still loading, so "None" isn't claimed yet. */
  const picker = (
    key: Key,
    legend: string,
    options: { id: string; label: string }[] | undefined,
  ) => (
    <fieldset>
      <legend className="fieldset-legend">{legend}</legend>
      {options?.length === 0 && <p className="text-sm opacity-70">{t("none")}</p>}
      <div className="flex max-h-40 flex-wrap gap-x-4 overflow-y-auto">
        {options?.map((option) => (
          <Checkbox
            key={option.id}
            isSelected={selection[key].includes(option.id)}
            onChange={(on) => toggle(key, option.id, on)}
          >
            {option.label}
          </Checkbox>
        ))}
      </div>
    </fieldset>
  );
  const named = (rows: { id: string; name: string }[] | undefined) =>
    rows?.map((r) => ({ id: r.id, label: r.name }));
  const titled = (rows: { id: string; title: string }[] | undefined) =>
    rows?.map((r) => ({ id: r.id, label: r.title }));

  const counts = preview.data;
  // While the new selection's preview loads, `counts` is the previous one's: don't start on it.
  const canStart =
    counts !== undefined &&
    !preview.isPlaceholderData &&
    counts.combinations > 0 &&
    !counts.overCap;

  return (
    <Dialog title={t("newRun")} isOpen onOpenChange={(open) => !open && onClose()}>
      {(close) => (
        <div className="space-y-4">
          <p className="text-sm opacity-70">{t("allHint")}</p>
          {picker("addressGroupIds", t("addressGroups"), named(addressGroups.data))}
          {picker("addressIds", t("addresses"), titled(addresses.data))}
          {picker("parcelGroupIds", t("parcelGroups"), named(parcelGroups.data))}
          {picker("parcelIds", t("parcels"), titled(parcels.data))}
          <p
            data-testid="lab-run-count"
            aria-live="polite"
            className={`font-semibold ${counts?.overCap ? "text-error" : ""}`}
          >
            {counts
              ? t("count", {
                  addresses: counts.addresses,
                  parcels: counts.parcels,
                  combinations: counts.combinations,
                })
              : t("counting")}
            {counts?.overCap && (
              <span className="block text-sm font-normal">{t("overCap", { cap: counts.cap })}</span>
            )}
          </p>
          {(start.error ?? preview.error) && (
            <p role="alert" className="text-error">
              {errorMessage(start.error ?? preview.error)}
            </p>
          )}
          <div className="modal-action">
            <Button className="btn-ghost" onPress={close}>
              {t("cancel")}
            </Button>
            <Button
              isDisabled={!canStart}
              isPending={start.isPending}
              onPress={() => start.mutate({ idempotencyKey, selection })}
            >
              {t("start")}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
