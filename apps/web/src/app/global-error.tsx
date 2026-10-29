"use client";

import { defaultLocale, isLocale, messages } from "@woolrus/i18n";
import { ErrorScreen } from "@/components/error-screen";
import { preferenceCookies } from "@/lib/preferences";

/** The locale cookie, else the browser's language: the root layout (and next-intl) is gone here. */
function currentLocale() {
  const cookie = document.cookie
    .split("; ")
    .find((entry) => entry.startsWith(`${preferenceCookies.locale}=`))
    ?.split("=")[1];
  const browser = navigator.language.slice(0, 2);
  return [cookie, browser].find(isLocale) ?? defaultLocale;
}

/** Render errors in the root layout itself; replaces the whole document. */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const locale = typeof document === "undefined" ? defaultLocale : currentLocale();
  return (
    <html lang={locale}>
      <body>
        <ErrorScreen error={error} retry={retry} text={messages[locale].errorScreen} />
      </body>
    </html>
  );
}
