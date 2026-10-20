import type { Preferences } from "@woolrus/contracts";

/**
 * FR-SET-03. The signed-in user's stored preferences win; these cookies carry the last ones onto
 * pages without a user (sign-in, after Log out). Not httpOnly: nothing secret, and the client
 * re-syncs them after a sign-in on another device.
 */
export const preferenceCookies = { locale: "locale", theme: "theme" } as const;

const oneYear = 365 * 24 * 60 * 60;

export function preferenceCookie(name: keyof typeof preferenceCookies, value: string): string {
  return `${preferenceCookies[name]}=${value}; Path=/; Max-Age=${oneYear}; SameSite=Lax`;
}

/** daisyUI theme for `<html data-theme>`; SYSTEM leaves it unset so `prefers-color-scheme` decides. */
export function themeAttribute(theme: Preferences["theme"] | undefined): string | undefined {
  switch (theme) {
    case "LIGHT":
      return "light";
    case "DARK":
      return "dark";
    case "HIGH_CONTRAST":
      return "contrast";
    default:
      return undefined;
  }
}

export function isTheme(value: string | undefined): value is Preferences["theme"] {
  return value === "SYSTEM" || value === "LIGHT" || value === "DARK" || value === "HIGH_CONTRAST";
}
