"use client";

import type { LotDto } from "@woolrus/contracts";
import { useTranslations } from "next-intl";
import { LotStatus, useLotText } from "./lot-status";

// Read-only lots per box line, with status (SPEC-lumexia "Reads and UI"): the order detail page
// and the pack screen's order drawer. The pack card's editable chips are the pack screen's own.

type LotItem = { orderItemId: string; name: string; needsLot: boolean; lots: LotDto[] };

/** Each line that needs or has a lot: **Lot needed**, or "2 × A12A0124" chips with their status. */
export function LotList({ items }: { items: readonly LotItem[] }) {
  const t = useTranslations();
  const lotText = useLotText();
  const lotItems = items.filter((it) => it.needsLot || it.lots.length > 0);
  if (lotItems.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1 text-sm" data-testid="lot-list">
      {lotItems.map((item) => (
        <li key={item.orderItemId} className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">{item.name}</span>
          {item.lots.length === 0 ? (
            <span className="badge badge-warning badge-sm">{t("pack.lotNeeded")}</span>
          ) : (
            <ul className="flex flex-wrap gap-2" aria-label={t("pack.lotsOf", { name: item.name })}>
              {item.lots.map((lot) => (
                <li
                  key={lot.id}
                  className="flex items-center gap-1 tabular-nums"
                  title={lot.lotNumber ?? lot.lumexiaLotId ?? undefined}
                  aria-label={t("lotLookup.lotWithStatus", {
                    count: lot.quantity,
                    lot: lotText(lot),
                    status: t(`lots.status.${lot.status}`),
                  })}
                  data-testid="lot-chip"
                >
                  <span className="badge badge-outline badge-sm">
                    {t("pack.lotChip", { count: lot.quantity, lot: lotText(lot) })}
                  </span>
                  <LotStatus status={lot.status} />
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}
