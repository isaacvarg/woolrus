"use client";

import { useMutation } from "@tanstack/react-query";
import type { QaPackage, QaView } from "@woolrus/contracts";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Form } from "react-aria-components";
import { Dialog } from "@/components/ui/dialog";
import { Button, TextField } from "@/components/ui/fields";
import { client } from "@/lib/orpc";
import { useQaRefetch } from "./qa-rates";

// Partial failure and lost responses (SPEC-qa "Settling and voiding"): a banner per package whose
// label was refused, and the way out of a purchase nobody could confirm.

const unknownKey = "errors.qa.purchaseUnknown";

/** A label left PURCHASING because nobody knows whether the provider bought it. */
export const isUnknownPurchase = (pkg: QaPackage) =>
  pkg.label?.status === "PURCHASING" && pkg.label.error === unknownKey;

/** One alert per package whose label was refused, with the reason and the bought count. */
export function FailedPackages({ view }: { view: QaView }) {
  const t = useTranslations();
  if (view.purchase.kind !== "failed") return null;
  const failed = view.packages.filter(
    (p) => view.purchase.kind === "failed" && view.purchase.packages.includes(p.number),
  );
  const bought = view.packages.filter((p) => p.label?.status === "ACTIVE").length;
  return (
    <div role="alert" className="alert alert-error block space-y-1" data-testid="qa-failed">
      <p className="font-semibold">
        {t("qa.partlyBought", { bought, total: view.packages.length })}
      </p>
      <ul className="list-disc ps-6">
        {failed.map((pkg) => (
          <li key={pkg.id} data-testid="qa-failed-package" data-package={pkg.number}>
            {t("qa.failedPackage", {
              number: pkg.number,
              reason:
                pkg.label?.error && t.has(pkg.label.error as never)
                  ? t(pkg.label.error as never)
                  : t("errors.internal"),
            })}
          </li>
        ))}
      </ul>
      <p className="text-sm">{t("qa.failedNext")}</p>
    </div>
  );
}

/** For a purchase of unknown outcome: where to look, and **Mark not bought** (confirm, reason). */
export function MarkNotBought({
  orderId,
  orderNumber,
  pkg,
}: {
  orderId: string;
  orderNumber: string;
  pkg: QaPackage;
}) {
  const t = useTranslations();
  const settle = useQaRefetch(orderId);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const mark = useMutation({
    mutationFn: (labelId: string) =>
      client.qa.markLabelNotBought({ labelId, reason: reason.trim() }),
    ...settle,
  });
  const labelId = pkg.label?.id;
  if (!labelId) return null;
  return (
    <div className="mt-2 space-y-2">
      <p>{t("qa.checkProvider", { number: orderNumber })}</p>
      <Button
        className="btn-warning btn-sm"
        onPress={() => setOpen(true)}
        data-testid="qa-mark-not-bought"
      >
        {t("qa.markNotBought")}
      </Button>
      <Dialog
        title={t("qa.markNotBoughtTitle", { number: pkg.number })}
        isOpen={open}
        onOpenChange={setOpen}
      >
        {(close) => (
          <Form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              mark.mutate(labelId, {
                onSuccess: () => {
                  setReason("");
                  close();
                },
              });
            }}
          >
            <p>{t("qa.markNotBoughtBody")}</p>
            <TextField
              label={t("qa.markNotBoughtReason")}
              name="reason"
              isRequired
              maxLength={500}
              validate={(value) => (value.trim() ? null : t("errors.field.required"))}
              value={reason}
              onChange={setReason}
            />
            <div className="modal-action">
              <Button className="btn-ghost" onPress={close}>
                {t("order.back")}
              </Button>
              <Button type="submit" className="btn-warning" isPending={mark.isPending}>
                {t("qa.markNotBought")}
              </Button>
            </div>
          </Form>
        )}
      </Dialog>
    </div>
  );
}
