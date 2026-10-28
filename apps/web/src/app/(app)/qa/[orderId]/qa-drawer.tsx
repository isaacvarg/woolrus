"use client";

import { useQuery } from "@tanstack/react-query";
import type { QaView } from "@woolrus/contracts";
import { useFormatter, useTranslations } from "next-intl";
import { Dialog as AriaDialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { formatAddress } from "@/app/(app)/orders/[id]/address";
import { HistoryPanel } from "@/app/(app)/orders/[id]/history-panel";
import { NoteList } from "@/components/notes/note-list";
import { DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/fields";
import { useErrorMessage } from "@/lib/errors";
import { orpc } from "@/lib/orpc";
import { money } from "./money";

// The QA order drawer (FR-QA-04): who picked and packed, the selected rate per package, QA
// verification and every note, without leaving the screen.

export function QaDrawer({ view }: { view: QaView }) {
  const t = useTranslations();
  return (
    <DialogTrigger>
      <Button className="btn-outline btn-sm min-h-12">{t("qa.drawerOpen")}</Button>
      <ModalOverlay isDismissable className="fixed inset-0 z-40 flex justify-end bg-black/40">
        <Modal className="h-full w-full max-w-xl overflow-y-auto bg-base-100 p-6 shadow-xl">
          <AriaDialog className="space-y-6 outline-none">
            {({ close }) => <DrawerBody view={view} close={close} />}
          </AriaDialog>
        </Modal>
      </ModalOverlay>
    </DialogTrigger>
  );
}

function DrawerBody({ view, close }: { view: QaView; close: () => void }) {
  const t = useTranslations();
  const format = useFormatter();
  const errorMessage = useErrorMessage();
  const orderId = view.order.id;
  // The address comes from the order record; the QA read carries the rest.
  const order = useQuery(orpc.orders.get.queryOptions({ input: { id: orderId } }));

  return (
    <>
      <div className="flex items-start justify-between gap-2">
        <Heading slot="title" className="text-2xl font-bold">
          {t("qa.drawerTitle", { number: view.order.number })}
        </Heading>
        <Button className="btn-ghost min-h-12" aria-label={t("qa.drawerClose")} onPress={close}>
          ✕
        </Button>
      </div>
      {order.error && (
        <p role="alert" className="alert alert-error">
          {errorMessage(order.error)}
        </p>
      )}
      {order.data && (
        <dl className="grid grid-cols-2 gap-3">
          <div>
            <dt className="text-sm opacity-70">{t("order.customer")}</dt>
            <dd className="font-semibold">{order.data.customerName}</dd>
          </div>
          <div>
            <dt className="text-sm opacity-70">{t("order.shippingMethod")}</dt>
            <dd>{order.data.shippingMethod ?? "—"}</dd>
          </div>
          <div className="col-span-2" data-testid="qa-drawer-address">
            <dt className="text-sm opacity-70">{t("qa.drawerAddress")}</dt>
            <dd>{formatAddress(order.data.shippingAddress)}</dd>
          </div>
        </dl>
      )}
      {view.customerNote && (
        <div className="alert alert-info">
          <span className="font-semibold">{t("qa.drawerCustomerNote")}:</span>
          <span className="whitespace-pre-line">{view.customerNote}</span>
        </div>
      )}

      <section aria-labelledby="qa-drawer-packages" className="space-y-3">
        <h3 id="qa-drawer-packages" className="text-xl font-bold">
          {t("qa.drawerPackages")}
        </h3>
        {view.packages.map((pkg) => (
          <div
            key={pkg.id}
            className="space-y-2 rounded-box bg-base-200 p-3"
            data-testid="qa-drawer-package"
          >
            <div className="font-semibold">{t("qa.package", { number: pkg.number })}</div>
            <div className="text-sm" data-testid="qa-drawer-rate">
              {pkg.selectedRate
                ? t("qa.drawerRate", {
                    service: pkg.selectedRate.serviceName,
                    carrier: pkg.selectedRate.carrierCode.toUpperCase(),
                    amount: money(format, pkg.selectedRate.amountCents),
                  })
                : t("qa.drawerNoRate")}
            </div>
            <ul className="space-y-2">
              {pkg.rows.map((row) => (
                <li key={row.id} className="text-sm" data-testid="qa-drawer-row">
                  <div className="font-semibold">
                    {row.name} ×{row.quantity}
                  </div>
                  <div className="opacity-70">
                    {t("qa.drawerPicked", { name: row.pickedBy ?? t("qa.drawerNobody") })} ·{" "}
                    {t("qa.drawerPacked", { name: row.packedBy ?? t("qa.drawerNobody") })}
                  </div>
                  <div className="opacity-70">
                    {t("qa.drawerVerification", {
                      verified: row.verifiedQuantity,
                      quantity: row.quantity,
                    })}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <HistoryPanel id={orderId} />

      <section aria-labelledby="qa-drawer-notes" className="space-y-2">
        <h3 id="qa-drawer-notes" className="text-xl font-bold">
          {t("qa.drawerNotes")}
        </h3>
        <NoteList orderId={orderId} canWriteCustomer={false} />
      </section>
    </>
  );
}
