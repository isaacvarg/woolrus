import { defaultLocale, isLocale, messages } from "@woolrus/i18n";
import { cookies } from "next/headers";
import { getRequestConfig } from "next-intl/server";

// No locale in URLs: the language follows the user's preference, stored in a cookie.
export default getRequestConfig(async () => {
  const cookie = (await cookies()).get("locale")?.value;
  const locale = isLocale(cookie) ? cookie : defaultLocale;
  return { locale, messages: messages[locale] };
});
