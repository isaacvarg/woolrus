"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ExternalChangeDiff, OrderDetail, OrderView } from "@woolrus/contracts";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/fields";
import { toast } from "@/components/ui/toast";
import { useErrorMessage } from "@/lib/errors";
import { client, orpc } from "@/lib/orpc";
import { formatAddress } from "./address";
import { ReasonDialog, type Unmet, unmetOf } from "./order-actions";

/**
 * What the store changed on an order already being worked on, old → new, with Apply / Dismiss for
 * those allowed (SPEC-store-sync "UI"). Everyone else sees the changes without the buttons.
 */
export function ExternalChangeBanner({ order }: { order: OrderView }) {
  const t = useTranslations();
  const format = useFormatter();
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const [unmet, setUnmet] = useState<Unmet[] | null>(null);

  const mutation = useMutation({
    mutationFn: ({ call }: { kind: "apply" | "dismiss"; call: () => Promise<OrderDetail> }) =>
      call(),
    onMutate: () => setUnmet(null),
    onSuccess: (result, { kind }) =>
      toast.success(
        t(kind === "apply" ? "order.externalChange.applied" : "order.externalChange.dismissed", {
          number: result.number,
        }),
      ),
    onError: (error) => {
      const missing = unmetOf(error);
      if (missing) setUnmet(missing);
      else toast.error(errorMessage(error));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: orpc.orders.key() }),
  });

  const change = order.externalChange;
  if (!change) return null;
  const versioned = { id: order.id, expectedVersion: order.version };
  const pending = (kind: "apply" | "dismiss") =>
    mutation.isPending && mutation.variables?.kind === kind;
  const canResolve = order.allowedActions.includes("resolveExternalChange");

  return (
    <section
      aria-labelledby="external-change-title"
      className="alert alert-warning flex flex-col items-stretch gap-3"
      data-testid="external-change-banner"
    >
      <div>
        <h2 id="external-change-title" className="text-lg font-bold">
          {t("order.externalChange.title")}
        </h2>
        <p className="text-sm">
          {t("order.externalChange.detected", {
            time: format.relativeTime(change.detectedAt, new Date()),
          })}
        </p>
      </div>

      <ChangeList diff={change.diff} />
      {change.diff.status && <p className="text-sm">{t("order.externalChange.statusNote")}</p>}

      {unmet && (
        <div role="alert" className="alert alert-error flex flex-col items-start">
          <p className="font-semibold">{t("errors.sync.cannotApply")}</p>
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
      )}

      {canResolve && (
        <div className="flex flex-wrap gap-2">
          <Button
            className="btn-primary btn-lg"
            isPending={pending("apply")}
            onPress={() =>
              mutation.mutate({
                kind: "apply",
                call: () => client.orders.externalChange.apply(versioned),
              })
            }
          >
            {t("order.actions.applyExternalChange")}
          </Button>
          <ReasonDialog
            action="dismissExternalChange"
            title={t("order.externalChange.dismissTitle")}
            buttonClass="btn-outline"
            isPending={pending("dismiss")}
            onSubmit={(reason, close) =>
              mutation
                .mutateAsync({
                  kind: "dismiss",
                  call: () => client.orders.externalChange.dismiss({ ...versioned, reason }),
                })
                .then(close, () => {})
            }
          />
        </div>
      )}
    </section>
  );
}

type FieldKey = Exclude<keyof ExternalChangeDiff, "lines">;

/** One line per changed field or order line, in words. */
function ChangeList({ diff }: { diff: ExternalChangeDiff }) {
  const t = useTranslations();
  const format = useFormatter();
  const none = t("order.externalChange.none");
  const text = (value: string | null) => value || none;
  const money = (cents: number) =>
    format.number(cents / 100, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const fields: { key: FieldKey; from: string; to: string }[] = [];
  const field = (key: FieldKey, from: string, to: string) => fields.push({ key, from, to });
  if (diff.status) field("status", diff.status.from, diff.status.to);
  if (diff.customer) {
    const who = (c: { name: string; email: string | null }) =>
      c.email ? `${c.name} <${c.email}>` : c.name;
    field("customer", who(diff.customer.from), who(diff.customer.to));
  }
  if (diff.shippingAddress) {
    const { from, to } = diff.shippingAddress;
    field("shippingAddress", text(formatAddress(from)), text(formatAddress(to)));
  }
  if (diff.billingAddress) {
    const { from, to } = diff.billingAddress;
    field("billingAddress", text(formatAddress(from)), text(formatAddress(to)));
  }
  if (diff.customerNote) {
    field("customerNote", text(diff.customerNote.from), text(diff.customerNote.to));
  }
  if (diff.shippingMethod) {
    field("shippingMethod", text(diff.shippingMethod.from), text(diff.shippingMethod.to));
  }
  if (diff.refunds) field("refunds", money(diff.refunds.from), money(diff.refunds.to));

  return (
    <ul className="space-y-1">
      {fields.map(({ key, from, to }) => (
        <li key={key}>
          <span className="font-semibold">{t(`order.externalChange.field.${key}`)}:</span>{" "}
          {t("order.externalChange.fromTo", { from, to })}
        </li>
      ))}
      {diff.lines.added.map((line) => (
        <li key={`added:${line.wooLineItemId}`}>
          {t("order.externalChange.lineAdded", { line: line.name, quantity: line.quantity })}
        </li>
      ))}
      {diff.lines.removed.map((line) => (
        <li key={`removed:${line.wooLineItemId}`}>
          {t("order.externalChange.lineRemoved", { line: line.name, quantity: line.quantity })}
        </li>
      ))}
      {diff.lines.quantity.map((line) => (
        <li key={`quantity:${line.wooLineItemId}`}>
          {t("order.externalChange.lineQuantity", {
            line: line.name,
            from: line.from,
            to: line.to,
          })}
        </li>
      ))}
    </ul>
  );
}
