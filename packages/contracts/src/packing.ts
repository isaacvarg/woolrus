import { z } from "zod";
import { base, Id, IdempotencyKey, Inches } from "./base";
import { Box } from "./boxes";
import { LineAttribute, OrderDetail } from "./orders";

// Packing (SPEC-packing "API"). Package writes need the order in Packing and the caller's live
// claim. Units move by adding or subtracting, so the client sends them one at a time per line.

const tags = ["Packing"];

/** A package's box: one of the active boxes, or custom outer dimensions. */
export const PackageBoxInput = z.union([
  z.object({ boxId: Id }),
  z.object({ lengthIn: Inches, widthIn: Inches, heightIn: Inches }),
]);
export type PackageBoxInput = z.infer<typeof PackageBoxInput>;

const Dimensions = z.object({ lengthIn: z.number(), widthIn: z.number(), heightIn: z.number() });

/** Where a line's units are: "4 in #1 · 2 in #2". */
export const PackedIn = z.object({
  packageId: Id,
  number: z.number().int(),
  quantity: z.number().int(),
});
export type PackedIn = z.infer<typeof PackedIn>;

/** One card on the items side. `quantity` is what's left to pack after voids. */
export const PackLine = z.object({
  id: Id,
  name: z.string(),
  sku: z.string().nullable(),
  imageUrl: z.string().nullable(),
  attributes: z.array(LineAttribute),
  substitutionNote: z.string().nullable(),
  quantity: z.number().int(),
  /** Units not in any package; never below 0. */
  unassigned: z.number().int(),
  /** Units packed beyond `quantity` (possible after a void); they must be unpacked. */
  tooMany: z.number().int(),
  packedIn: z.array(PackedIn),
  noteCount: z.number().int(),
});
export type PackLine = z.infer<typeof PackLine>;

export const PackageItemView = z.object({
  orderItemId: Id,
  name: z.string(),
  quantity: z.number().int(),
});
export type PackageItemView = z.infer<typeof PackageItemView>;

export const PackPackage = z.object({
  id: Id,
  number: z.number().int(),
  /** The box, or null for custom dimensions. */
  box: Box.nullable(),
  /** Custom outer dimensions; null when the package has a box. */
  dimensions: Dimensions.nullable(),
  weightOz: z.number().nullable(),
  items: z.array(PackageItemView),
  units: z.number().int(),
  noteCount: z.number().int(),
});
export type PackPackage = z.infer<typeof PackPackage>;

const Unmet = z.object({
  messageKey: z.string(),
  params: z.record(z.string(), z.union([z.string(), z.number()])),
});

export const PackView = z.object({
  order: OrderDetail,
  customerNote: z.string().nullable(),
  /** Physical lines with something to pack, in pick order. */
  lines: z.array(PackLine),
  packages: z.array(PackPackage),
  /** The active boxes a packer can choose from. */
  boxes: z.array(Box),
  /** What the packed gate still needs; empty when the order can complete. */
  unmet: z.array(Unmet),
});
export type PackView = z.infer<typeof PackView>;

/** What every package write returns: both sides of the screen, in one round trip. */
export const PackResult = z.object({
  lines: z.array(PackLine),
  packages: z.array(PackPackage),
  unmet: z.array(Unmet),
});
export type PackResult = z.infer<typeof PackResult>;

export const AddPackageInput = z.object({
  orderId: Id,
  box: PackageBoxInput,
  /** A retried request must not add a second package. */
  idempotencyKey: IdempotencyKey,
});
export type AddPackageInput = z.infer<typeof AddPackageInput>;

export const SetPackageBoxInput = z.object({ packageId: Id, box: PackageBoxInput });
export type SetPackageBoxInput = z.infer<typeof SetPackageBoxInput>;

export const PackageIdInput = z.object({ packageId: Id });
export type PackageIdInput = z.infer<typeof PackageIdInput>;

export const PackUnitsInput = z.object({
  packageId: Id,
  orderItemId: Id,
  /** Defaults to one unit. Core checks the upper bound against what's unassigned or packed. */
  quantity: z.number().int().min(1).max(10_000).default(1),
});
// The input type: callers in core may leave `quantity` out, as the default applies on parse.
export type PackUnitsInput = z.input<typeof PackUnitsInput>;

export const packing = {
  view: base
    .route({
      method: "GET",
      path: "/orders/{orderId}/pack",
      tags,
      summary: "The pack screen: lines, packages, boxes and what's still missing",
    })
    .input(z.object({ orderId: Id }))
    .output(PackView),
  addPackage: base
    .route({
      method: "POST",
      path: "/orders/{orderId}/packages",
      tags,
      summary: "Add a package with an active box or custom dimensions",
    })
    .input(AddPackageInput)
    .output(PackResult),
  setBox: base
    .route({
      method: "POST",
      path: "/packages/{packageId}/box",
      tags,
      summary: "Change a package's box or custom dimensions",
    })
    .input(SetPackageBoxInput)
    .output(PackResult),
  deletePackage: base
    .route({
      method: "DELETE",
      path: "/packages/{packageId}",
      tags,
      summary: "Delete a package; its units return to unassigned",
    })
    .input(PackageIdInput)
    .output(PackResult),
  packUnits: base
    .route({
      method: "POST",
      path: "/packages/{packageId}/pack",
      tags,
      summary: "Put units of a line into a package",
    })
    .input(PackUnitsInput)
    .output(PackResult),
  unpackUnits: base
    .route({
      method: "POST",
      path: "/packages/{packageId}/unpack",
      tags,
      summary: "Take units of a line out of a package",
    })
    .input(PackUnitsInput)
    .output(PackResult),
  packRemaining: base
    .route({
      method: "POST",
      path: "/packages/{packageId}/pack-remaining",
      tags,
      summary: "Put every unassigned unit into a package",
    })
    .input(PackageIdInput)
    .output(PackResult),
};
