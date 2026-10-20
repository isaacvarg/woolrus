import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { NextIntlClientProvider } from "next-intl";
import { getLocale } from "next-intl/server";
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
  const theme = (await currentUser())?.theme ?? (isTheme(cookie) ? cookie : undefined);
  return (
    <html lang={locale} data-theme={themeAttribute(theme)}>
      <body className="min-h-dvh bg-base-200">
        <NextIntlClientProvider>
          <Providers>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
