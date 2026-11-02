"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { WooPushView } from "@woolrus/contracts";
import { useFormatter, useTranslations } from "next-intl";
import { Button } from "@/components/ui/fields";
import { toast } from "@/components/ui/toast";
import { useErrorMessage } from "@/lib/errors";
import { client, orpc } from "@/lib/orpc";

// Where the WooCommerce update of a shipped order stands (SPEC-shipping "WooCommerce push").

const badge: Record<WooPushView["status"], string> = {
  NOT_NEEDED: "badge-ghost",
  PENDING: "badge-warning",
  SUCCEEDED: "badge-success",
  FAILED: "badge-error",
};

export function WooPushStatus({
  orderId,
  push,
  canRetry = false,
}: {
  orderId: string;
  push: WooPushView;
  canRetry?: boolean;
}) {
  const t = useTranslations();
  const format = useFormatter();
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const retry = useMutation({
    mutationFn: () => client.shipping.retryWooPush({ orderIds: [orderId] }),
    onSuccess: () => toast.success(t("pushErrors.retried")),
    onError: (error) => toast.error(errorMessage(error)),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: orpc.orders.key() });
      queryClient.invalidateQueries({ queryKey: orpc.shipping.key() });
    },
  });
  if (push.status === "NOT_NEEDED") return null;
  return (
    <section aria-labelledby="woo-push-heading" className="space-y-2">
      <h2 id="woo-push-heading" className="text-xl font-bold">
        {t("wooPush.title")}
      </h2>
      <p className="flex flex-wrap items-center gap-2">
        <span className={`badge ${badge[push.status]}`}>{t(`wooPush.status.${push.status}`)}</span>
        <span className="text-sm">{t("wooPush.attempts", { count: push.attempts })}</span>
        {push.pushedAt && (
          <span className="text-sm">
            {t("wooPush.pushedAt", {
              at: format.dateTime(push.pushedAt, { dateStyle: "medium", timeStyle: "short" }),
            })}
          </span>
        )}
      </p>
      {push.error && (
        <p role={push.status === "FAILED" ? "alert" : undefined} className="text-sm">
          {t.has(push.error) ? t(push.error) : t("errors.internal")}
        </p>
      )}
      {canRetry && push.status === "FAILED" && (
        <Button className="btn-outline" isPending={retry.isPending} onPress={() => retry.mutate()}>
          {t("pushErrors.retry")}
        </Button>
      )}
    </section>
  );
}
