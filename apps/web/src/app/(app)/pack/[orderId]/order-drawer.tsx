"use client";

import { useQuery } from "@tanstack/react-query";
import type { PackPackage } from "@woolrus/contracts";
import { useFormatter, useTranslations } from "next-intl";
import { Dialog as AriaDialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { formatAddress } from "@/app/(app)/orders/[id]/address";
import { HistoryPanel } from "@/app/(app)/orders/[id]/history-panel";
import { NoteComposer } from "@/components/notes/note-composer";
import { NoteList } from "@/components/notes/note-list";
import { Dialog, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/fields";
import { useErrorMessage } from "@/lib/errors";
import { orpc } from "@/lib/orpc";

// The order drawer (FR-PACK-08): what a packer wants to know about the order without leaving the
// screen. It reuses `orders.get`, `orders.history` and `notes.list`.

/** The header button and the slide-in modal it opens. */
export function OrderDrawer({ orderId }: { orderId: string }) {
  const t = useTranslations();
  return (
    <DialogTrigger>
      <Button className="btn-outline btn-sm min-h-12">{t("pack.drawerOpen")}</Button>
      <ModalOverlay isDismissable className="fixed inset-0 z-40 flex justify-end bg-black/40">
        <Modal className="h-full w-full max-w-xl overflow-y-auto bg-base-100 p-6 shadow-xl">
          <AriaDialog className="space-y-6 outline-none">
            {({ close }) => <DrawerBody orderId={orderId} close={close} />}
          </AriaDialog>
        </Modal>
      </ModalOverlay>
    </DialogTrigger>
  );
}

function DrawerBody({ orderId, close }: { orderId: string; close: () => void }) {
  const t = useTranslations();
  const format = useFormatter();
  const errorMessage = useErrorMessage();
  const order = useQuery(orpc.orders.get.queryOptions({ input: { id: orderId } }));

  return (
    <>
      <div className="flex items-start justify-between gap-2">
        <Heading slot="title" className="text-2xl font-bold">
          {order.data ? t("pack.drawerTitle", { number: order.data.number }) : t("pack.drawerOpen")}
        </Heading>
        <Button className="btn-ghost min-h-12" aria-label={t("pack.drawerClose")} onPress={close}>
          ✕
        </Button>
      </div>
      {order.isPending && <p>{t("common.loading")}</p>}
      {order.error && (
        <p role="alert" className="alert alert-error">
          {errorMessage(order.error)}
        </p>
      )}
      {order.data && (
        <>
          <dl className="grid grid-cols-2 gap-3">
            <div>
              <dt className="text-sm opacity-70">{t("order.status")}</dt>
              <dd className="font-semibold">{t(`status.${order.data.status}`)}</dd>
            </div>
            <div>
              <dt className="text-sm opacity-70">{t("order.customer")}</dt>
              <dd className="font-semibold">{order.data.customerName}</dd>
            </div>
            <div>
              <dt className="text-sm opacity-70">{t("order.orderedAt")}</dt>
              <dd>
                {format.dateTime(order.data.orderedAt, { dateStyle: "medium", timeStyle: "short" })}
              </dd>
            </div>
            <div>
              <dt className="text-sm opacity-70">{t("order.shippingMethod")}</dt>
              <dd>{order.data.shippingMethod ?? "—"}</dd>
            </div>
            <div className="col-span-2" data-testid="drawer-address">
              <dt className="text-sm opacity-70">{t("pack.drawerAddress")}</dt>
              <dd>{formatAddress(order.data.shippingAddress)}</dd>
            </div>
          </dl>

          <section aria-labelledby="drawer-lines" className="space-y-2">
            <h3 id="drawer-lines" className="text-xl font-bold">
              {t("pack.drawerLines")}
            </h3>
            <ul className="space-y-2">
              {order.data.lines.map((line) => (
                <li key={line.id} className="rounded-box bg-base-200 p-3" data-testid="drawer-line">
                  <div className="font-semibold">
                    {line.name} ×{line.quantity}
                  </div>
                  <div className="text-sm opacity-70">
                    {line.physical && line.pickedBy && line.pickedAt
                      ? t("order.pickedBy", {
                          name: line.pickedBy.name,
                          time: format.dateTime(line.pickedAt, {
                            dateStyle: "short",
                            timeStyle: "short",
                          }),
                        })
                      : line.physical
                        ? t("pack.drawerNoPicker")
                        : t("order.notPhysical")}
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <HistoryPanel id={orderId} />

          <section aria-labelledby="drawer-notes" className="space-y-2">
            <h3 id="drawer-notes" className="text-xl font-bold">
              {t("notes.title")}
            </h3>
            <NoteList orderId={orderId} canWriteCustomer={false} />
          </section>
        </>
      )}
    </>
  );
}

/** The package card's "Add note": a composer fixed on that package. */
export function PackageNoteDialog({
  orderId,
  pkg,
  onClose,
}: {
  orderId: string;
  pkg: PackPackage;
  onClose: () => void;
}) {
  const t = useTranslations();
  return (
    <Dialog
      title={t("pack.addNoteTitle", { number: pkg.number })}
      isOpen
      onOpenChange={(open) => !open && onClose()}
    >
      {() => (
        <NoteComposer
          orderId={orderId}
          canWriteCustomer={false}
          initialTarget={{ kind: "package", id: pkg.id }}
          onAdded={onClose}
        />
      )}
    </Dialog>
  );
}
