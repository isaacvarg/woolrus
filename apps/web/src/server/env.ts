import { z } from "zod";

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  BETTER_AUTH_URL: z.url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  ADMIN_EMAILS: z
    .string()
    .default("")
    .transform((value) =>
      value
        .split(",")
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean),
    ),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  DISCORD_CLIENT_ID: z.string().optional(),
  DISCORD_CLIENT_SECRET: z.string().optional(),
});

/**
 * The warehouse's IANA time zone (e.g. `America/Los_Angeles`). Every timestamp the app shows is
 * formatted in it, so screens don't depend on the server's own `TZ` (the prod container runs UTC).
 */
export function parseWarehouseTimeZone(value: string | undefined): string {
  if (!value)
    throw new Error("WAREHOUSE_TIME_ZONE is not set (an IANA zone like America/Los_Angeles)");
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
  } catch {
    throw new Error(`WAREHOUSE_TIME_ZONE "${value}" is not an IANA time zone`);
  }
  return value;
}

let zone: string | undefined;
export function warehouseTimeZone() {
  zone ??= parseWarehouseTimeZone(process.env.WAREHOUSE_TIME_ZONE);
  return zone;
}

/** Validated server environment. Read lazily so `next build` doesn't need runtime secrets. */
let cached: z.infer<typeof Env> | undefined;
export function env() {
  cached ??= Env.parse(process.env);
  return cached;
}
