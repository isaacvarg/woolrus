"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { Button, Checkbox } from "@/components/ui/fields";
import { toast } from "@/components/ui/toast";
import { useErrorMessage } from "@/lib/errors";
import { client, orpc } from "@/lib/orpc";

/**
 * Shipped orders whose WooCommerce update failed or has sat pending too long, with a bulk Retry
 * (SPEC-shipping "Push errors view", FR-SHIP-10).
 */
export function PushErrors() {
  const t = useTranslations();
  const format = useFormatter();
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string[]>([]);
  const errors = useQuery({ ...orpc.shipping.pushErrors.queryOptions(), refetchInterval: 15_000 });

  const retry = useMutation({
    mutationFn: (orderIds: string[]) => client.shipping.retryWooPush({ orderIds }),
    onSuccess: ({ retried }) => {
      setSelected([]);
      toast.success(t("pushErrors.retriedCount", { count: retried }));
    },
    onError: (error) => toast.error(errorMessage(error)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: orpc.shipping.key() }),
  });

  const rows = errors.data?.rows ?? [];
  const toggle = (id: string, on: boolean) =>
    setSelected((now) => (on ? [...now, id] : now.filter((x) => x !== id)));

  return (
    <section className="space-y-3" data-testid="push-errors" aria-labelledby="push-errors-heading">
      <h2 id="push-errors-heading" className="text-xl font-semibold">
        {t("pushErrors.title")}
      </h2>
      <p className="text-base-content/70">{t("pushErrors.intro")}</p>
      {errors.error && (
        <p role="alert" className="alert alert-error">
          {errorMessage(errors.error)}
        </p>
      )}
      {errors.data && rows.length === 0 && <p>{t("pushErrors.none")}</p>}
      {rows.length > 0 && (
        <>
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th />
                  <th>{t("pushErrors.order")}</th>
                  <th>{t("pushErrors.error")}</th>
                  <th>{t("pushErrors.attempts")}</th>
                  <th>{t("pushErrors.lastTry")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.orderId}>
                    <td>
                      <Checkbox
                        aria-label={t("pushErrors.selectOrder", { number: row.orderNumber })}
                        isSelected={selected.includes(row.orderId)}
                        onChange={(on) => toggle(row.orderId, on)}
                      >
                        {null}
                      </Checkbox>
                    </td>
                    <td>
                      <Link className="link" href={`/orders/${row.orderId}`}>
                        {row.orderNumber}
                      </Link>
                    </td>
                    <td>
                      <span
                        className={`badge badge-sm me-2 ${row.status === "FAILED" ? "badge-error" : "badge-warning"}`}
                      >
                        {t(`pushErrors.status.${row.status}`)}
                      </span>
                      {row.error && t.has(row.error) ? t(row.error as never) : null}
                    </td>
                    <td>{row.attempts}</td>
                    <td>
                      {format.dateTime(row.lastTryAt, { dateStyle: "medium", timeStyle: "short" })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Button
            isDisabled={selected.length === 0}
            isPending={retry.isPending}
            onPress={() => retry.mutate(selected)}
          >
            {t("pushErrors.retrySelected")}
          </Button>
        </>
      )}
    </section>
  );
}
