"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QaPackage, QaResult, QaTrip, QaView } from "@woolrus/contracts";
import { Check, TriangleAlert } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { Button } from "@/components/ui/fields";
import { toast } from "@/components/ui/toast";
import { useErrorMessage } from "@/lib/errors";
import { client, orpc } from "@/lib/orpc";
import type { Unmet } from "../../orders/[id]/order-actions";
import { TripMessage } from "../../pack/[orderId]/trips";

// QA's side of the packing checks (SPEC-packing A1 "QA side"): the trips saved when the order left
// Packing, each acknowledged on its own, and the box confirmed on the bench when it's required.

/** The package card's warning style, so a tripped package stands out before it's read. */
export const trippedCard = "border-2 border-warning bg-warning/10";

/** "⚠ N checks" beside the package title: the count, not only the colour. */
export function ChecksBadge({ pkg }: { pkg: QaPackage }) {
  const t = useTranslations();
  if (pkg.trips.length === 0) return null;
  return (
    <span className="badge badge-warning ms-2 gap-1" data-testid="qa-checks-badge">
      <TriangleAlert className="size-4" aria-hidden="true" />
      {t("qa.checks", { count: pkg.trips.length })}
    </span>
  );
}

/** QA writes on checks share the screen's lane, so they land in the order they were made. */
function useCheckWrite<I>(orderId: string, mutationFn: (input: I) => Promise<QaResult>) {
  const queryClient = useQueryClient();
  const errorMessage = useErrorMessage();
  const viewKey = orpc.qa.screen.queryKey({ input: { orderId } });
  return useMutation({
    mutationKey: ["qaWrite", orderId],
    scope: { id: `qa:${orderId}` },
    mutationFn,
    onSuccess: async (result: QaResult) => {
      await queryClient.cancelQueries({ queryKey: viewKey });
      queryClient.setQueryData<QaView>(viewKey, (v) => (v ? { ...v, ...result } : v));
    },
    onError: (error) => {
      toast.error(errorMessage(error));
      void queryClient.invalidateQueries({ queryKey: viewKey });
    },
  });
}

export function PackageChecks({
  pkg,
  orderId,
  disabled,
}: {
  pkg: QaPackage;
  orderId: string;
  disabled: boolean;
}) {
  const t = useTranslations();
  const acknowledge = useCheckWrite(orderId, (tripId: string) =>
    client.qa.acknowledgeCheck({ tripId }),
  );
  const confirm = useCheckWrite(orderId, () => client.qa.confirmBox({ packageId: pkg.id }));
  if (pkg.trips.length === 0 && !pkg.boxConfirmRequired && !pkg.boxConfirmed) return null;
  return (
    <div className="space-y-2">
      {pkg.trips.length > 0 && (
        <ul className="space-y-2" aria-label={t("qa.checks", { count: pkg.trips.length })}>
          {pkg.trips.map((trip) => (
            <TripRow
              key={trip.id}
              pkg={pkg}
              trip={trip}
              disabled={disabled || acknowledge.isPending}
              onAcknowledge={() => acknowledge.mutate(trip.id)}
            />
          ))}
        </ul>
      )}
      {(pkg.boxConfirmRequired || pkg.boxConfirmed) && (
        <ConfirmBoxRow
          pkg={pkg}
          disabled={disabled || confirm.isPending}
          onConfirm={() => confirm.mutate(undefined)}
        />
      )}
    </div>
  );
}

function TripRow({
  pkg,
  trip,
  disabled,
  onAcknowledge,
}: {
  pkg: QaPackage;
  trip: QaTrip;
  disabled: boolean;
  onAcknowledge: () => void;
}) {
  const t = useTranslations();
  const settings = useQuery(orpc.settings.public.queryOptions());
  const acknowledged = trip.acknowledgedAt !== null;
  return (
    <li
      className="flex flex-wrap items-center gap-3 rounded-box border border-warning bg-base-100 p-3"
      data-testid="qa-trip"
      data-check={trip.trip.check}
      data-acknowledged={acknowledged}
    >
      <TriangleAlert className="size-5 shrink-0 text-warning" aria-hidden="true" />
      <span className="grow">
        <TripMessage
          pkg={pkg}
          trip={trip.trip}
          weightDisplay={settings.data?.weightDisplay ?? "LB_OZ"}
        />
        {trip.approval && (
          <span className="block text-sm opacity-80" data-testid="qa-trip-approval">
            {t("qa.tripApproved", { name: trip.approval.approver, reason: trip.approval.reason })}
          </span>
        )}
        {trip.forced && (
          <span className="block text-sm opacity-80" data-testid="qa-trip-forced">
            {t("qa.tripForced", { reason: trip.forced.reason })}
          </span>
        )}
      </span>
      {acknowledged ? (
        <span className="flex items-center gap-1 text-sm" data-testid="qa-trip-acknowledged">
          <Check className="size-4" aria-hidden="true" />
          {t("qa.acknowledgedBy", { name: trip.acknowledgedBy ?? "—" })}
        </span>
      ) : (
        <Button
          className="btn-warning min-h-12"
          isDisabled={disabled}
          onPress={onAcknowledge}
          data-testid="qa-trip-acknowledge"
        >
          {t("qa.acknowledge")}
        </Button>
      )}
    </li>
  );
}

function ConfirmBoxRow({
  pkg,
  disabled,
  onConfirm,
}: {
  pkg: QaPackage;
  disabled: boolean;
  onConfirm: () => void;
}) {
  const t = useTranslations();
  const format = useFormatter();
  const size = pkg.dimensions;
  const n = (value: number) => format.number(value, { maximumFractionDigits: 2 });
  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-box bg-base-200 p-3"
      data-testid="qa-confirm-box"
      data-confirmed={pkg.boxConfirmed !== null}
    >
      <span className="grow">
        <span className="block text-sm opacity-70">{t("qa.confirmBoxTitle")}</span>
        <span className="block text-2xl font-bold" data-testid="qa-confirm-box-name">
          {pkg.boxName ?? t("qa.customBox")}
          {size && (
            <span className="ms-2 tabular-nums">
              {t("qa.boxSize", {
                length: n(size.lengthIn),
                width: n(size.widthIn),
                height: n(size.heightIn),
              })}
            </span>
          )}
        </span>
      </span>
      {pkg.boxConfirmed ? (
        <span className="flex items-center gap-1 text-sm" data-testid="qa-box-confirmed">
          <Check className="size-4" aria-hidden="true" />
          {t("qa.boxConfirmedBy", { name: pkg.boxConfirmed.by ?? "—" })}
        </span>
      ) : (
        <Button
          className="btn-primary min-h-12"
          isDisabled={disabled}
          onPress={onConfirm}
          data-testid="qa-confirm-box-button"
        >
          {t("qa.confirmBox")}
        </Button>
      )}
    </div>
  );
}

/** What still stops **Complete QA** (buying the labels), one line per condition. */
export function QaUnmet({ unmet }: { unmet: Unmet[] }) {
  const t = useTranslations();
  if (unmet.length === 0) return null;
  return (
    <div role="status" className="alert alert-warning flex-col items-start" data-testid="qa-unmet">
      <p className="font-semibold">{t("qa.unmetTitle")}</p>
      <ul className="list-disc ps-6">
        {unmet.map((condition) => (
          <li key={`${condition.messageKey}:${JSON.stringify(condition.params)}`}>
            {t.has(condition.messageKey)
              ? t(condition.messageKey, condition.params as never)
              : t("errors.internal")}
          </li>
        ))}
      </ul>
    </div>
  );
}
