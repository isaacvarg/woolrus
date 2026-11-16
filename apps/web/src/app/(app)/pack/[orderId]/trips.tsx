"use client";

import type { PackPackage, Trip, WeightDisplay } from "@woolrus/contracts";
import { formatWeight } from "@woolrus/core/format";
import { TriangleAlert } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

// A package's live packing check trips (SPEC-packing A1 "Pack screen"). Amber with a ⚠ icon, so a
// trip isn't told by colour alone. The server recalculates them on every package write.

export function TripList({
  pkg,
  trips,
  weightDisplay,
}: {
  pkg: PackPackage;
  trips: Trip[];
  weightDisplay: WeightDisplay;
}) {
  if (trips.length === 0) return null;
  return (
    <ul className="space-y-2 px-4 pb-4">
      {trips.map((trip) => (
        <li
          key={trip.check}
          role="status"
          className={`alert ${trip.mode === "BLOCK" ? "alert-error" : "alert-warning"}`}
          data-testid="pack-trip"
          data-check={trip.check}
        >
          <TriangleAlert className="size-5 shrink-0" aria-hidden="true" />
          <TripMessage pkg={pkg} trip={trip} weightDisplay={weightDisplay} />
        </li>
      ))}
    </ul>
  );
}

function TripMessage({
  pkg,
  trip,
  weightDisplay,
}: {
  pkg: PackPackage;
  trip: Trip;
  weightDisplay: WeightDisplay;
}) {
  const t = useTranslations();
  const locale = useLocale();
  switch (trip.check) {
    case "OVER_MAX":
      return (
        <span>
          {t("pack.tripOverMax", { max: formatWeight(trip.details.maxOz, weightDisplay, locale) })}
          {trip.details.reason && (
            <span className="block" data-testid="pack-override">
              {trip.details.reason}
            </span>
          )}
        </span>
      );
    case "WEIGHT_OFF":
      return (
        <span>
          {t(trip.details.percent > 0 ? "pack.warnHeavier" : "pack.warnLighter", {
            percent: Math.abs(trip.details.percent),
          })}
        </span>
      );
    case "WEIGHT_STALE":
      return <span>{t("pack.stale")}</span>;
    case "NO_FIT": {
      const items = new Intl.ListFormat(locale, { type: "conjunction" }).format(trip.details.items);
      const count = trip.details.items.length;
      if (trip.details.boxName) {
        return <span>{t("pack.tripNoFit", { count, items, box: trip.details.boxName })}</span>;
      }
      const size = pkg.dimensions;
      return (
        <span>
          {t("pack.tripNoFitCustom", {
            count,
            items,
            length: size?.lengthIn ?? 0,
            width: size?.widthIn ?? 0,
            height: size?.heightIn ?? 0,
          })}
        </span>
      );
    }
    case "CUSTOM_DIMENSIONS":
      return (
        <span>
          {t("pack.tripCustom", {
            length: trip.details.lengthIn,
            width: trip.details.widthIn,
            height: trip.details.heightIn,
          })}
        </span>
      );
  }
}
