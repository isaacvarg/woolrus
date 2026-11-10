/**
 * Station-only users (SPEC-identity amendment 1) keep Better Auth's required, unique email by
 * holding a placeholder on a reserved domain. `.invalid` is reserved by RFC 2606, so the address
 * can never exist or receive mail. This file is the only code that knows the domain: everything
 * else asks `isStationOnly`, and the placeholder never leaves core.
 */
const STATION_ONLY_DOMAIN = "station.invalid";

/** True for a station-only user's placeholder address (any case). */
export function isStationOnly(email: string): boolean {
  return email.toLowerCase().endsWith(`@${STATION_ONLY_DOMAIN}`);
}

/** The address to show outside core: null for a placeholder, which never leaves core. */
export function publicEmail(email: string): string | null {
  return isStationOnly(email) ? null : email;
}

/** A fresh placeholder for a new station-only user: `<random uuid>@station.invalid`. */
export function stationOnlyPlaceholder(): string {
  return `${crypto.randomUUID()}@${STATION_ONLY_DOMAIN}`;
}

/**
 * A Prisma string filter matching placeholders. Email searches exclude it (`NOT`), so searching for
 * the domain, or any part of a placeholder, never finds a station-only user by it.
 */
export const stationOnlyEmailFilter = {
  endsWith: `@${STATION_ONLY_DOMAIN}`,
  mode: "insensitive",
} as const;
