"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { OrderAddress, PackageShipping, RateError, ShipToView } from "@woolrus/contracts";
import { useFormatter, useTranslations } from "next-intl";
import type { ReactNode } from "react";
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
  const settle = {
    onError: (error: Error) => toast.error(errorMessage(error)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: orpc.carriers.orderShipping.key() }),
  };
  const refresh = useMutation({
    mutationFn: () => client.carriers.refreshRates({ orderId }),
    onSuccess: () => toast.success(t("orderShipping.refreshing")),
    ...settle,
  });
  const keepOriginal = useMutation({
    mutationFn: () => client.carriers.keepOriginalAddress({ orderId }),
    onSuccess: () => toast.success(t("orderShipping.usingOriginal")),
    ...settle,
  });
  const recheck = useMutation({
    mutationFn: () => client.carriers.recheckAddress({ orderId }),
    onSuccess: () => toast.success(t("orderShipping.rechecking")),
    ...settle,
  });
  const busy = refresh.isPending || keepOriginal.isPending || recheck.isPending;

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
            isDisabled={busy}
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
        <div className="space-y-3">
          <ShipTo
            shipTo={shipping.data.shipTo}
            actions={
              canRefresh &&
              shipping.data.refreshable &&
              shipping.data.shipTo.address && (
                <>
                  {shipping.data.shipTo.status === "CORRECTED" && (
                    <Button
                      className="btn-sm btn-outline"
                      isPending={keepOriginal.isPending}
                      isDisabled={busy}
                      onPress={() => keepOriginal.mutate()}
                    >
                      {t("orderShipping.useOriginal")}
                    </Button>
                  )}
                  <Button
                    className="btn-sm btn-ghost"
                    isPending={recheck.isPending}
                    isDisabled={busy}
                    onPress={() => recheck.mutate()}
                  >
                    {t("orderShipping.recheck")}
                  </Button>
                </>
              )
            }
          />
          {shipping.data.packages.map((pkg) => (
            <PackageRates key={pkg.id} pkg={pkg} />
          ))}
        </div>
      )}
    </section>
  );
}

const addressFields = [
  "name",
  "company",
  "address1",
  "address2",
  "city",
  "state",
  "postalCode",
  "country",
] as const satisfies readonly (keyof OrderAddress)[];

/** The fields a correction changed, in address order. */
function changedFields(from: OrderAddress, to: OrderAddress) {
  return addressFields.filter((field) => (from[field] ?? "") !== (to[field] ?? ""));
}

/**
 * The address rates use and its check. A correction shows the original beside it, naming what
 * changed. `actions`: QA's address buttons, when the viewer may use them.
 */
export function ShipTo({ shipTo, actions }: { shipTo: ShipToView; actions?: ReactNode }) {
  const t = useTranslations();
  const list = useFormatter();
  const fieldName = (field: string) =>
    t.has(`orderShipping.fields.${field}` as never)
      ? t(`orderShipping.fields.${field}` as never)
      : field;
  const fetched = shipTo.address !== null || shipTo.status === "INCOMPLETE";
  const corrected =
    shipTo.status === "CORRECTED" && shipTo.address && shipTo.original ? shipTo.original : null;
  return (
    <div className="space-y-2 rounded-box bg-base-100 p-4 shadow-sm" data-testid="ship-to">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm opacity-70">{t("orderShipping.shipTo")}</span>
        {fetched && (
          <span className={`badge ${shipToBadge[shipTo.status]}`}>
            {t(`orderShipping.shipToStatus.${shipTo.status}`)}
          </span>
        )}
        {actions && <span className="ms-auto flex flex-wrap gap-2">{actions}</span>}
      </div>
      {shipTo.status === "INCOMPLETE" ? (
        <p className="text-error">
          {t("orderShipping.incomplete", {
            fields: list.list(shipTo.messages.map(fieldName)),
          })}
        </p>
      ) : shipTo.address && corrected ? (
        <>
          <dl className="grid gap-2 md:grid-cols-2">
            <div data-testid="ship-to-original">
              <dt className="text-sm opacity-70">{t("orderShipping.original")}</dt>
              <dd>{formatAddress(corrected)}</dd>
            </div>
            <div data-testid="ship-to-corrected">
              <dt className="text-sm opacity-70">{t("orderShipping.correctedTo")}</dt>
              <dd>{formatAddress(shipTo.address)}</dd>
            </div>
          </dl>
          <p className="text-sm">
            {t("orderShipping.changed", {
              fields: list.list(changedFields(corrected, shipTo.address).map(fieldName)),
            })}
          </p>
        </>
      ) : shipTo.address ? (
        <p>{formatAddress(shipTo.address)}</p>
      ) : shipTo.original ? (
        <>
          <p>{formatAddress(shipTo.original)}</p>
          <p className="text-sm opacity-70" aria-live="polite">
            {t("orderShipping.checking")}
          </p>
        </>
      ) : (
        <p className="text-sm opacity-70">{t("orderShipping.notResolved")}</p>
      )}
      {shipTo.address && shipTo.status === "UNCHECKED" && (
        <p className="text-sm opacity-70">{t("orderShipping.unchecked")}</p>
      )}
      {shipTo.status === "ERROR" && (
        <p className="alert alert-warning">{t("orderShipping.undeliverable")}</p>
      )}
      {shipTo.status !== "INCOMPLETE" && shipTo.messages.length > 0 && (
        <ul className="list-inside list-disc text-sm" data-testid="ship-to-messages">
          {shipTo.messages.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
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
                <tr
                  key={rate.id}
                  className={rate.selected ? "bg-success/15 font-medium" : undefined}
                >
                  <td>{t(`settings.shipping.names.${rate.provider}`)}</td>
                  <td>{rate.carrierName}</td>
                  <td>
                    {rate.selected && (
                      <>
                        <span aria-hidden="true" className="me-1 font-bold text-success">
                          ✓
                        </span>
                        <span className="sr-only">{t("orderShipping.selected")}: </span>
                      </>
                    )}
                    {rate.serviceName}
                    {rate.guaranteed && (
                      <span className="badge badge-ghost ms-2">
                        {t("orderShipping.guaranteed")}
                      </span>
                    )}
                  </td>
                  <td className="text-end tabular-nums">
                    {price(format, rate.amountCents, rate.currency)}
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

/**
 * The amount in its currency. A code that isn't ISO 4217-shaped (a provider's typo) can't be
 * formatted, and next-intl's fallback would drop the currency, so it shows the number and the code.
 */
function price(format: ReturnType<typeof useFormatter>, cents: number, currency: string): string {
  if (/^[A-Z]{3}$/.test(currency)) {
    return format.number(cents / 100, { style: "currency", currency });
  }
  const amount = format.number(cents / 100, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${amount} ${currency}`;
}
