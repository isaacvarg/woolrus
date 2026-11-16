"use client";

import type { PackPackage, Trip, WeightDisplay } from "@woolrus/contracts";
import { formatWeight } from "@woolrus/core/format";
import { TriangleAlert } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

// A package's live packing check trips (SPEC-packing A1 "Pack screen"). A warning is amber with a ⚠
// icon, so a trip isn't told by colour alone; a blocking one is red and says it needs approval. The
// server recalculates them on every package write.

export function TripList({
  pkg,
  trips,
  weightDisplay,
}: {
  pkg: PackPackage;
  trips: Trip[];
  weightDisplay: WeightDisplay;
}) {
  const t = useTranslations();
  // One live region that is always there, so a trip appearing is announced and the list keeps its
  // list semantics.
  return (
    <div role="status">
      {trips.length > 0 && (
        <ul className="space-y-2 px-4 pb-4">
          {trips.map((trip) => (
            <li
              key={trip.check}
              className={`alert ${trip.mode === "BLOCK" ? "alert-error" : "alert-warning"}`}
              data-testid="pack-trip"
              data-check={trip.check}
            >
              <TriangleAlert className="size-5 shrink-0" aria-hidden="true" />
              <span>
                <TripMessage pkg={pkg} trip={trip} weightDisplay={weightDisplay} />
                {trip.mode === "BLOCK" && (
                  <span className="block font-semibold" data-testid="pack-trip-blocks">
                    {t("pack.tripNeedsApproval")}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** What one trip says: on the card, in the approval dialog's list, and for saved trips on QA. */
export function TripMessage({
  pkg,
  trip,
  weightDisplay,
}: {
  pkg: Pick<PackPackage, "dimensions">;
  trip: Trip;
  weightDisplay: WeightDisplay;
}) {
  const t = useTranslations();
  const locale = useLocale();
  switch (trip.check) {
    case "OVER_MAX":
      return (
        <span>
          {t("pack.tripOverMax", {
            weight: formatWeight(trip.details.weightOz, weightDisplay, locale),
            max: formatWeight(trip.details.maxOz, weightDisplay, locale),
          })}
          {trip.details.reason && (
            <span className="block" data-testid="pack-override">
              {trip.details.reason}
            </span>
          )}
        </span>
      );
    case "UNDER_MIN":
      return (
        <span>
          {t("pack.tripUnderMin", {
            weight: formatWeight(trip.details.weightOz, weightDisplay, locale),
            min: formatWeight(trip.details.minOz, weightDisplay, locale),
          })}
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
    case "BOX_NOT_SCANNED":
      return <span>{t("pack.tripBoxNotScanned", { box: trip.details.boxName })}</span>;
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
