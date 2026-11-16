import { z } from "zod";

// Packing checks (SPEC-packing A1 "Packing checks"). A check that fails on a package is a trip.
// Evaluated live while the order is in Packing; nothing here is stored yet.

/** The checks, in the spec table's order. */
export const PackCheck = z.enum([
  "OVER_MAX",
  "UNDER_MIN",
  "WEIGHT_OFF",
  "WEIGHT_STALE",
  "NO_FIT",
  "BOX_NOT_SCANNED",
  "CUSTOM_DIMENSIONS",
]);
export type PackCheck = z.infer<typeof PackCheck>;

/** A check's warehouse-wide mode (decision 10). */
export const PackCheckMode = z.enum(["OFF", "WARN", "BLOCK"]);
export type PackCheckMode = z.infer<typeof PackCheckMode>;

const TripMode = z.enum(["WARN", "BLOCK"]);

/** One failed check, with what the packer (and later QA) needs to read it. */
export const Trip = z.discriminatedUnion("check", [
  z.object({
    check: z.literal("OVER_MAX"),
    mode: TripMode,
    /** `reason`: the packer's override reason, in warn mode. */
    details: z.object({ weightOz: z.number(), maxOz: z.number(), reason: z.string().optional() }),
  }),
  z.object({
    check: z.literal("UNDER_MIN"),
    mode: TripMode,
    details: z.object({ weightOz: z.number(), minOz: z.number() }),
  }),
  z.object({
    check: z.literal("WEIGHT_OFF"),
    mode: TripMode,
    /** `percent`: signed whole percent off the estimate (negative = lighter). */
    details: z.object({ weightOz: z.number(), estimateOz: z.number(), percent: z.number() }),
  }),
  z.object({
    check: z.literal("WEIGHT_STALE"),
    mode: TripMode,
    details: z.object({ weightOz: z.number() }),
  }),
  z.object({
    check: z.literal("NO_FIT"),
    mode: TripMode,
    /** `boxName`: absent for a custom size. `items`: the measured units that don't fit. */
    details: z.object({ boxName: z.string().optional(), items: z.array(z.string()) }),
  }),
  z.object({
    check: z.literal("BOX_NOT_SCANNED"),
    mode: TripMode,
    details: z.object({ boxName: z.string() }),
  }),
  z.object({
    check: z.literal("CUSTOM_DIMENSIONS"),
    mode: TripMode,
    details: z.object({ lengthIn: z.number(), widthIn: z.number(), heightIn: z.number() }),
  }),
]);
export type Trip = z.infer<typeof Trip>;
