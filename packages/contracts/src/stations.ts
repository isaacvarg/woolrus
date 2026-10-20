import { z } from "zod";
import { base, Id } from "./base";

/** A shared floor tablet as admins see it. Never its token or token hash. */
export const StationSummary = z.object({
  id: Id,
  name: z.string(),
  active: z.boolean(),
  /** Who is unlocked on it now, if anyone. */
  currentUserName: z.string().nullable(),
  lastSeenAt: z.date().nullable(),
  createdAt: z.date(),
});
export type StationSummary = z.infer<typeof StationSummary>;

export const StationName = z
  .string()
  .trim()
  .min(1, "errors.field.required")
  .max(40, "errors.stations.nameTooLong");

export const RegisterStationInput = z.object({ name: StationName });
export type RegisterStationInput = z.infer<typeof RegisterStationInput>;

export const RenameStationInput = z.object({ id: Id, name: StationName });
export type RenameStationInput = z.infer<typeof RenameStationInput>;

/** What the station device itself may know: its name. Unlock state comes with unlocking. */
export const StationStatus = z.object({ id: Id, name: z.string() });
export type StationStatus = z.infer<typeof StationStatus>;

export const stations = {
  list: base
    .route({ method: "GET", path: "/stations", tags: ["Stations"], summary: "List stations" })
    .output(z.array(StationSummary)),

  register: base
    .route({
      method: "POST",
      path: "/stations",
      tags: ["Stations"],
      summary:
        "Make the calling device a station: sets its station cookie and signs out the caller",
    })
    .input(RegisterStationInput)
    .output(StationSummary),

  rename: base
    .route({ method: "PATCH", path: "/stations/{id}", tags: ["Stations"], summary: "Rename" })
    .input(RenameStationInput)
    .output(StationSummary),

  revoke: base
    .route({
      method: "DELETE",
      path: "/stations/{id}",
      tags: ["Stations"],
      summary: "Revoke a station; the device falls back to the sign-in page",
    })
    .input(z.object({ id: Id }))
    .output(StationSummary),
};

/** Called by the station device itself, with its station cookie and no unlocked user. */
export const station = {
  status: base
    .route({ method: "GET", path: "/station", tags: ["Station"], summary: "This station" })
    .output(StationStatus),
};
