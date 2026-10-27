"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { OrderShipping, PackageShipping, RateError, ShipToView } from "@woolrus/contracts";
import { useFormatter, useTranslations } from "next-intl";
import { formatAddress } from "@/app/(app)/orders/[id]/address";
import { Button } from "@/components/ui/fields";
import { toast } from "@/components/ui/toast";
import { useErrorMessage } from "@/lib/errors";
import { client, orpc } from "@/lib/orpc";

// An order's ship-to and each package's rates, read-only (SPEC-carriers "UI"). The order detail
// shows it; `qa` builds its rate choice on the same pieces.

const shipToBadge: Record<ShipToView["status"], string> = {
  UNCHECKED: "badge-ghost",
  VERIFIED: "badge-success",
  CORRECTED: "badge-info",
  WARNING: "badge-warning",
  ERROR: "badge-error",
  INCOMPLETE: "badge-error",
};

/** The Shipping section. `canRefresh`: the viewer has `order.qa` (the API checks it again). */
export function OrderShippingPanel({
  orderId,
  canRefresh,
}: {
  orderId: string;
  canRefresh: boolean;
}) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const shipping = useQuery(orpc.carriers.orderShipping.queryOptions({ input: { orderId } }));
  const refresh = useMutation({
    mutationFn: () => client.carriers.refreshRates({ orderId }),
    onSuccess: () => toast.success(t("orderShipping.refreshing")),
    onError: (error) => toast.error(errorMessage(error)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: orpc.carriers.orderShipping.key() }),
  });

  return (
    <section aria-labelledby="shipping-heading" className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h2 id="shipping-heading" className="text-xl font-bold">
          {t("orderShipping.title")}
        </h2>
        {canRefresh && shipping.data?.refreshable && (
          <Button
            className="btn-outline btn-primary"
            isPending={refresh.isPending}
            onPress={() => refresh.mutate()}
          >
            {t("orderShipping.refresh")}
          </Button>
        )}
      </div>
      {shipping.isPending ? (
        <p>{t("common.loading")}</p>
      ) : shipping.error ? (
        <p role="alert" className="alert alert-error">
          {errorMessage(shipping.error)}
        </p>
      ) : (
        <ShippingBody shipping={shipping.data} />
      )}
    </section>
  );
}

function ShippingBody({ shipping }: { shipping: OrderShipping }) {
  return (
    <div className="space-y-3">
      <ShipTo shipTo={shipping.shipTo} />
      {shipping.packages.map((pkg) => (
        <PackageRates key={pkg.id} pkg={pkg} />
      ))}
    </div>
  );
}

export function ShipTo({ shipTo }: { shipTo: ShipToView }) {
  const t = useTranslations();
  const list = useFormatter();
  const fetched = shipTo.address !== null || shipTo.status === "INCOMPLETE";
  return (
    <div className="rounded-box bg-base-100 p-4 shadow-sm" data-testid="ship-to">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm opacity-70">{t("orderShipping.shipTo")}</span>
        {fetched && (
          <span className={`badge ${shipToBadge[shipTo.status]}`}>
            {t(`orderShipping.shipToStatus.${shipTo.status}`)}
          </span>
        )}
      </div>
      {shipTo.status === "INCOMPLETE" ? (
        <p className="text-error">
          {t("orderShipping.incomplete", {
            fields: list.list(
              shipTo.messages.map((field) =>
                t.has(`orderShipping.fields.${field}` as never)
                  ? t(`orderShipping.fields.${field}` as never)
                  : field,
              ),
            ),
          })}
        </p>
      ) : shipTo.address ? (
        <p>{formatAddress(shipTo.address)}</p>
      ) : (
        <p className="text-sm opacity-70">{t("orderShipping.notResolved")}</p>
      )}
    </div>
  );
}

function useRateErrorText() {
  const t = useTranslations();
  return (error: RateError) => {
    const reason = t.has(error.messageKey as never)
      ? t(error.messageKey as never)
      : t("errors.internal");
    return error.provider
      ? t("orderShipping.providerError", {
          provider: t(`settings.shipping.names.${error.provider}`),
          reason,
        })
      : reason;
  };
}

export function PackageRates({ pkg }: { pkg: PackageShipping }) {
  const t = useTranslations();
  const format = useFormatter();
  const errorText = useRateErrorText();
  const label = t("orderShipping.rates", { number: pkg.number });
  const dateTime = (at: Date) => format.dateTime(at, { dateStyle: "short", timeStyle: "short" });

  return (
    <div className="space-y-2 rounded-box bg-base-100 p-4 shadow-sm" data-testid="package-rates">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">{t("orderShipping.package", { number: pkg.number })}</h3>
        <span className="text-sm opacity-70" aria-live="polite">
          {t(`orderShipping.ratesStatus.${pkg.ratesStatus}`)}
          {pkg.ratesFetchedAt &&
            pkg.ratesStatus !== "FETCHING" &&
            ` · ${t("orderShipping.fetchedAt", { time: dateTime(pkg.ratesFetchedAt) })}`}
        </span>
      </div>
      {pkg.ratesStatus === "STALE" && (
        <p className="alert alert-warning">{t("orderShipping.stale")}</p>
      )}
      {pkg.rateErrors.length > 0 && (
        <ul className="space-y-1" data-testid="rate-errors">
          {pkg.rateErrors.map((error) => (
            <li key={`${error.provider}-${error.messageKey}`} className="alert alert-warning">
              {errorText(error)}
            </li>
          ))}
        </ul>
      )}
      {pkg.rates.length === 0 ? (
        pkg.ratesStatus === "READY" || pkg.ratesStatus === "FAILED" ? (
          <p className="text-sm opacity-70">{t("orderShipping.noRates")}</p>
        ) : null
      ) : (
        <div className="overflow-x-auto">
          <table className="table" aria-label={label}>
            <thead>
              <tr>
                <th>{t("orderShipping.columns.provider")}</th>
                <th>{t("orderShipping.columns.carrier")}</th>
                <th>{t("orderShipping.columns.service")}</th>
                <th className="text-end">{t("orderShipping.columns.price")}</th>
                <th>{t("orderShipping.columns.delivery")}</th>
                <th className="hidden md:table-cell">{t("orderShipping.columns.expires")}</th>
              </tr>
            </thead>
            <tbody>
              {pkg.rates.map((rate) => (
                <tr key={rate.id} className={rate.selected ? "bg-base-200" : undefined}>
                  <td>{t(`settings.shipping.names.${rate.provider}`)}</td>
                  <td>{rate.carrierName}</td>
                  <td>
                    {rate.serviceName}
                    {rate.selected && (
                      <span className="badge badge-primary ms-2">
                        {t("orderShipping.selected")}
                      </span>
                    )}
                    {rate.guaranteed && (
                      <span className="badge badge-ghost ms-2">
                        {t("orderShipping.guaranteed")}
                      </span>
                    )}
                  </td>
                  <td className="text-end tabular-nums">
                    {format.number(rate.amountCents / 100, {
                      style: "currency",
                      currency: rate.currency,
                    })}
                  </td>
                  <td>
                    {rate.deliveryDays !== null
                      ? t("orderShipping.deliveryDays", { count: rate.deliveryDays })
                      : rate.estimatedDeliveryAt
                        ? format.dateTime(rate.estimatedDeliveryAt, { dateStyle: "medium" })
                        : "—"}
                  </td>
                  <td className="hidden md:table-cell">
                    {rate.expired ? (
                      <span className="badge badge-warning">{t("orderShipping.expired")}</span>
                    ) : rate.expiresAt ? (
                      dateTime(rate.expiresAt)
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
