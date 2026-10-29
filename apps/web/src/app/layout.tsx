import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { NextIntlClientProvider } from "next-intl";
import { getLocale } from "next-intl/server";
import { ErrorReporting } from "@/components/error-reporting";
import { Providers } from "@/components/providers";
import { isTheme, preferenceCookies, themeAttribute } from "@/lib/preferences";
import { currentUser } from "@/server/actor";
import "./globals.css";

export const metadata: Metadata = {
  title: "Woolrus",
  description: "Warehouse fulfillment for WooCommerce",
  applicationName: "Woolrus",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#1d232a",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const cookie = (await cookies()).get(preferenceCookies.theme)?.value;
  const user = await currentUser();
  const theme = user?.theme ?? (isTheme(cookie) ? cookie : undefined);
  return (
    <html lang={locale} data-theme={themeAttribute(theme)}>
      <body className="min-h-dvh bg-base-200">
        {/* Read per request: the image is built once, so the DSN can't be baked in. */}
        <ErrorReporting
          dsn={process.env.SENTRY_DSN || undefined}
          userId={user?.id}
          release={process.env.WOOLRUS_VERSION || undefined}
          environment={process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV}
        />
        <NextIntlClientProvider>
          <Providers>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
