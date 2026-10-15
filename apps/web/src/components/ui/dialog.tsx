"use client";

// A modal dialog: React Aria handles focus trapping, Escape and the accessible name (from the
// heading); daisyUI tokens do the styling. Not daisyUI's .modal-box: it stays invisible outside a
// .modal-open parent. The trigger is the first child of `DialogTrigger`.
import type { ReactNode } from "react";
import {
  Dialog as AriaDialog,
  Heading,
  Modal,
  ModalOverlay,
  type ModalOverlayProps,
} from "react-aria-components";

export { DialogTrigger } from "react-aria-components";

export function Dialog({
  title,
  children,
  ...props
}: Omit<ModalOverlayProps, "children"> & {
  title: string;
  /** Receives `close` so the dialog's own buttons can dismiss it. */
  children: (close: () => void) => ReactNode;
}) {
  return (
    <ModalOverlay
      isDismissable
      {...props}
      className="fixed inset-0 z-40 grid place-items-center bg-black/40 p-4"
    >
      <Modal className="w-full max-w-lg rounded-box bg-base-100 p-6 shadow-xl">
        <AriaDialog className="space-y-4 outline-none">
          {({ close }) => (
            <>
              <Heading slot="title" className="text-xl font-bold">
                {title}
              </Heading>
              {children(close)}
            </>
          )}
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  );
}
