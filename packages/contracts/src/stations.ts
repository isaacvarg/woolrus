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

/** A name on the lock screen: just enough to find yourself, nothing to sign in with. */
export const UnlockTile = z.object({ id: Id, name: z.string(), initials: z.string() });
export type UnlockTile = z.infer<typeof UnlockTile>;

/**
 * What the station device itself may know: its name, who is on it, and the unlock tiles (active
 * users with a PIN, most recent on this station first).
 */
export const StationStatus = z.object({
  id: Id,
  name: z.string(),
  activeUserName: z.string().nullable(),
  tiles: z.array(UnlockTile),
});
export type StationStatus = z.infer<typeof StationStatus>;

// Loose on purpose: a malformed PIN is just a wrong PIN (`errors.station.badPin`), so the shape
// of the answer never depends on what was typed.
export const UnlockPinInput = z.object({ userId: Id, pin: z.string().max(64) });
export type UnlockPinInput = z.infer<typeof UnlockPinInput>;

export const UnlockBadgeInput = z.object({ code: z.string().trim().min(1).max(64) });
export type UnlockBadgeInput = z.infer<typeof UnlockBadgeInput>;

/** Who the station now acts as. */
export const StationUnlocked = z.object({ userName: z.string() });
export type StationUnlocked = z.infer<typeof StationUnlocked>;

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

/**
 * Called by the station device itself, with its station cookie and no unlocked user needed;
 * `lock` and `touch` need the unlocked station actor.
 */
export const station = {
  status: base
    .route({ method: "GET", path: "/station", tags: ["Station"], summary: "This station" })
    .output(StationStatus),

  unlockPin: base
    .route({
      method: "POST",
      path: "/station/unlock/pin",
      tags: ["Station"],
      summary: "Unlock this station as a user, with their PIN",
    })
    .input(UnlockPinInput)
    .output(StationUnlocked),

  unlockBadge: base
    .route({
      method: "POST",
      path: "/station/unlock/badge",
      tags: ["Station"],
      summary: "Unlock this station with a scanned badge",
    })
    .input(UnlockBadgeInput)
    .output(StationUnlocked),

  lock: base
    .route({
      method: "POST",
      path: "/station/lock",
      tags: ["Station"],
      summary: "Lock this station: the user on it is done",
    })
    .output(z.object({ ok: z.literal(true) })),

  touch: base
    .route({
      method: "POST",
      path: "/station/touch",
      tags: ["Station"],
      summary: "Input on this station: pushes its idle lock out",
    })
    .output(z.object({ idleLockAt: z.date() })),
};
