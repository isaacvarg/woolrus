import { z } from "zod";
import { base, Id } from "./base";

export const Role = z.enum(["ADMIN", "PICKER", "PACKER", "QA", "SHIPPER"]);
export type Role = z.infer<typeof Role>;

export const Locale = z.enum(["en", "es"]);
export const Theme = z.enum(["SYSTEM", "LIGHT", "DARK", "HIGH_CONTRAST"]);

/** FR-SET-03: saved on the user, so they follow them to every device and station. */
export const Preferences = z.object({
  locale: Locale,
  theme: Theme,
  sidebarCollapsed: z.boolean(),
});
export type Preferences = z.infer<typeof Preferences>;

export const UpdatePreferencesInput = Preferences.partial();
export type UpdatePreferencesInput = z.infer<typeof UpdatePreferencesInput>;

export const Me = z.object({
  id: Id,
  name: z.string(),
  email: z.string(),
  image: z.string().nullable(),
  roles: z.array(Role),
  permissions: z.array(z.string()),
  locale: Locale,
  theme: Theme,
  sidebarCollapsed: z.boolean(),
  stationId: Id.nullable(),
  /** The station this request acts from, if any: the nav shows it, and Lock instead of Log out. */
  stationName: z.string().nullable(),
});
export type Me = z.infer<typeof Me>;

export const me = {
  get: base
    .route({ method: "GET", path: "/me", tags: ["Me"], summary: "The signed-in user" })
    .output(Me),

  updatePreferences: base
    .route({
      method: "PATCH",
      path: "/me/preferences",
      tags: ["Me"],
      summary: "Change the signed-in user's language, theme or sidebar",
    })
    .input(UpdatePreferencesInput)
    .output(Preferences),
};
