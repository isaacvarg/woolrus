import { defaultLocale, isLocale, messages } from "@woolrus/i18n";
import { cookies } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { preferenceCookies } from "@/lib/preferences";
import { currentUser } from "@/server/actor";

// No locale in URLs. The signed-in user's saved language wins, so it follows them to any device
// (FR-SET-03); signed out, the cookie keeps the last one.
export default getRequestConfig(async () => {
  const cookie = (await cookies()).get(preferenceCookies.locale)?.value;
  const locale = (await currentUser())?.locale ?? (isLocale(cookie) ? cookie : defaultLocale);
  return { locale, messages: messages[locale] };
});
