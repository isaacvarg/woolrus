"use client";

import { useTranslations } from "next-intl";
import { ErrorScreen } from "@/components/error-screen";

/** Render errors below the root layout: a translated screen with Try again. */
export default function AppError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const t = useTranslations("errorScreen");
  return (
    <ErrorScreen
      error={error}
      retry={retry}
      text={{
        title: t("title"),
        body: t("body"),
        retry: t("retry"),
        reference: t("reference"),
      }}
    />
  );
}
