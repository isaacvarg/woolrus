import { z } from "zod";
import { base } from "./base";

// Settings (FR-SET-05, FR-SHIP-09, FR-SET-06). Secret values never appear in any output schema here
// (NFR-SEC-03).

const LOCAL_HOST = /^(localhost|.+\.localhost)$/;

const parseUrl = (value: string) => (URL.canParse(value) ? new URL(value) : null);

/**
 * https://, or http:// for localhost and *.localhost (the dev stack). No username or password in
 * the URL: it would be stored and shown in plain text, outside the encrypted secrets.
 */
export const IntegrationUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    const url = parseUrl(value);
    return (
      url !== null &&
      (url.protocol === "https:" || (url.protocol === "http:" && LOCAL_HOST.test(url.hostname)))
    );
  }, "errors.field.urlHttps")
  .refine((value) => {
    const url = parseUrl(value);
    return url === null || (url.username === "" && url.password === "");
  }, "errors.field.urlCredentials");

const text = (max: number) => z.string().trim().min(1).max(max);

/** One US warehouse (decisions.md). Carriers require the phone number. */
export const ShipFromAddress = z.object({
  name: text(100),
  company: text(100).optional(),
  phone: z.string().trim().min(7).max(30),
  email: z.email("errors.field.email").optional(),
  address1: text(100),
  address2: text(100).optional(),
  city: text(60),
  state: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, "errors.field.usState"),
  postalCode: z.string().regex(/^\d{5}(-\d{4})?$/, "errors.field.usZip"),
  country: z.literal("US"),
});
export type ShipFromAddress = z.infer<typeof ShipFromAddress>;

const slaMinutes = z.number().int().min(1).max(10_080);

/** Per-stage SLA thresholds in minutes (FR-LIST-05). Unset stages have no SLA. */
export const StageSlaMinutes = z.strictObject({
  PENDING: slaMinutes.optional(),
  PICKING: slaMinutes.optional(),
  PACKING: slaMinutes.optional(),
  QA: slaMinutes.optional(),
  READY: slaMinutes.optional(),
});
export type StageSlaMinutes = z.infer<typeof StageSlaMinutes>;

export const WeightDisplay = z.enum(["LB_OZ", "LB_DECIMAL"]);
export type WeightDisplay = z.infer<typeof WeightDisplay>;

const SyncIntervalMinutes = z.number().int().min(1).max(60);
const StationIdleLockMinutes = z.number().int().min(1).max(120);
/** Null keeps customer PII forever (NFR-SEC-06). */
const PiiRetentionDays = z.number().int().min(30).max(3650).nullable();

export const SecretName = z.enum([
  "wooConsumerKey",
  "wooConsumerSecret",
  "wooWebhookSecret",
  "shipstationApiKey",
  "lumexiaApiKey",
]);
export type SecretName = z.infer<typeof SecretName>;

/** Whether a secret is set. Deliberately nothing derived from the value, not even a hint. */
export const SecretStatus = z.object({ configured: z.boolean() });
export type SecretStatus = z.infer<typeof SecretStatus>;

/** Everything an admin sees. Secrets appear only as `{ configured }` statuses, never values. */
export const AdminSettings = z.object({
  shipFromAddress: ShipFromAddress.nullable(),
  wooStoreUrl: z.string().nullable(),
  lumexiaBaseUrl: z.string().nullable(),
  syncIntervalMinutes: z.number(),
  stationIdleLockMinutes: z.number(),
  stageSlaMinutes: StageSlaMinutes,
  weightDisplay: WeightDisplay,
  piiRetentionDays: z.number().nullable(),
  qaMustDifferFromPacker: z.boolean(),
  secrets: z.record(SecretName, SecretStatus),
});
export type AdminSettings = z.infer<typeof AdminSettings>;

/** The operational values every signed-in user's UI needs. */
export const PublicSettings = AdminSettings.pick({
  weightDisplay: true,
  stationIdleLockMinutes: true,
  stageSlaMinutes: true,
});
export type PublicSettings = z.infer<typeof PublicSettings>;

/** Partial: omitted fields are left as they are. */
export const UpdateSettingsInput = z.object({
  shipFromAddress: ShipFromAddress.optional(),
  wooStoreUrl: IntegrationUrl.nullable().optional(),
  lumexiaBaseUrl: IntegrationUrl.nullable().optional(),
  syncIntervalMinutes: SyncIntervalMinutes.optional(),
  stationIdleLockMinutes: StationIdleLockMinutes.optional(),
  stageSlaMinutes: StageSlaMinutes.optional(),
  weightDisplay: WeightDisplay.optional(),
  piiRetentionDays: PiiRetentionDays.optional(),
  qaMustDifferFromPacker: z.boolean().optional(),
});
export type UpdateSettingsInput = z.infer<typeof UpdateSettingsInput>;

/** Write-only: the value is never returned by any procedure. */
export const SetSecretInput = z.object({
  name: SecretName,
  value: z.string().trim().min(1).max(500),
});
export type SetSecretInput = z.infer<typeof SetSecretInput>;

export const ClearSecretInput = z.object({ name: SecretName });
export type ClearSecretInput = z.infer<typeof ClearSecretInput>;

export const settings = {
  get: base
    .route({
      method: "GET",
      path: "/settings",
      tags: ["Settings"],
      summary: "All settings (admin)",
    })
    .output(AdminSettings),

  public: base
    .route({
      method: "GET",
      path: "/settings/public",
      tags: ["Settings"],
      summary: "Operational settings for every signed-in user",
    })
    .output(PublicSettings),

  update: base
    .route({ method: "PATCH", path: "/settings", tags: ["Settings"], summary: "Update settings" })
    .input(UpdateSettingsInput)
    .output(AdminSettings),

  setSecret: base
    .route({
      method: "PUT",
      path: "/settings/secrets/{name}",
      tags: ["Settings"],
      summary: "Set an integration secret (write-only)",
    })
    .input(SetSecretInput)
    .output(AdminSettings),

  clearSecret: base
    .route({
      method: "DELETE",
      path: "/settings/secrets/{name}",
      tags: ["Settings"],
      summary: "Clear an integration secret",
    })
    .input(ClearSecretInput)
    .output(AdminSettings),
};
