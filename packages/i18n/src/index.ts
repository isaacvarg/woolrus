import en from "./messages/en.json" with { type: "json" };
import es from "./messages/es.json" with { type: "json" };

export const locales = ["en", "es"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en";

export type Messages = typeof en;

export const messages: Record<Locale, Messages> = { en, es };

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (locales as readonly string[]).includes(value);
}

type Leaves<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];

/** Every translatable key, e.g. "errors.box.inUse". */
export type MessageKey = Leaves<Messages>;

/**
 * Error codes the API returns. Clients translate them with the catalog,
 * so the server never sends user-facing English.
 */
export type ErrorCode = Extract<MessageKey, `errors.${string}`>;
