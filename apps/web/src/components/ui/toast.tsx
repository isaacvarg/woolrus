"use client";

// Result messages (NFR-UX-04). React Aria's toast is marked UNSTABLE, so it stays behind this file:
// the rest of the app only calls `toast.success/error`.
import { useTranslations } from "next-intl";
import {
  Button,
  Text,
  UNSTABLE_Toast as Toast,
  UNSTABLE_ToastContent as ToastContent,
  UNSTABLE_ToastQueue as ToastQueue,
  UNSTABLE_ToastRegion as ToastRegion,
} from "react-aria-components";

type ToastMessage = { kind: "success" | "error"; text: string };

const queue = new ToastQueue<ToastMessage>({ maxVisibleToasts: 3 });

/** Messages are already translated by the caller. Errors stay longer: people need to read why. */
export const toast = {
  success: (text: string) => queue.add({ kind: "success", text }, { timeout: 5_000 }),
  error: (text: string) => queue.add({ kind: "error", text }, { timeout: 10_000 }),
};

export function Toaster() {
  const t = useTranslations("common");
  return (
    <ToastRegion
      queue={queue}
      aria-label={t("notifications")}
      className="toast toast-end toast-bottom z-50"
    >
      {({ toast: item }) => (
        <Toast
          toast={item}
          className={`alert ${item.content.kind === "error" ? "alert-error" : "alert-success"} shadow-lg`}
        >
          <ToastContent>
            <Text slot="title">{item.content.text}</Text>
          </ToastContent>
          <Button
            slot="close"
            aria-label={t("dismiss")}
            className="btn btn-ghost btn-sm btn-circle"
          >
            ✕
          </Button>
        </Toast>
      )}
    </ToastRegion>
  );
}
