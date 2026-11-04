import { z } from "zod";
import { base, Id, IdempotencyKey, Inches, Ounces } from "./base";
import { ShipToStatus } from "./carriers";
import { RealOrders, RealOrdersInput } from "./rate-lab-real-orders";

// Rate Lab (SPEC-rate-lab): test addresses and parcels, and the groups that tag them. Runs join
// this file in their own tickets.

const text = (max: number) => z.string().trim().min(1).max(max);
/** Blank means absent, so an empty form field doesn't fail `min(1)`. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => value || undefined)
    .optional();

/**
 * A test address as typed: any country, with US states and ZIP codes checked the way Settings
 * checks the ship-from.
 */
export const LabShipAddress = z
  .object({
    name: text(100),
    company: optionalText(100),
    phone: optionalText(30),
    email: z
      .union([z.literal(""), z.email("errors.field.email")])
      .transform((value) => value || undefined)
      .optional(),
    address1: text(100),
    address2: optionalText(100),
    city: text(60),
    state: z.string().trim().toUpperCase().max(60).default(""),
    postalCode: z.string().trim().toUpperCase().min(1).max(20),
    country: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{2}$/, "errors.field.country"),
  })
  .superRefine((address, ctx) => {
    if (address.country !== "US") return;
    if (!/^[A-Z]{2}$/.test(address.state)) {
      ctx.addIssue({ code: "custom", path: ["state"], message: "errors.field.usState" });
    }
    if (!/^\d{5}(-\d{4})?$/.test(address.postalCode)) {
      ctx.addIssue({ code: "custom", path: ["postalCode"], message: "errors.field.usZip" });
    }
  });
export type LabShipAddress = z.infer<typeof LabShipAddress>;

/** A stored address: what the provider check returned may carry any of these fields. */
export const LabAddressValue = z.object({
  name: z.string(),
  company: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  address1: z.string(),
  address2: z.string().optional(),
  city: z.string(),
  state: z.string(),
  postalCode: z.string(),
  country: z.string(),
});
export type LabAddressValue = z.infer<typeof LabAddressValue>;

export const RateLabGroupKind = z.enum(["ADDRESS", "PARCEL"]);
export type RateLabGroupKind = z.infer<typeof RateLabGroupKind>;

export const LabGroup = z.object({
  id: Id,
  kind: RateLabGroupKind,
  name: z.string(),
  archived: z.boolean(),
});
export type LabGroup = z.infer<typeof LabGroup>;

export const LabGroupRef = LabGroup.pick({ id: true, name: true, archived: true });
export type LabGroupRef = z.infer<typeof LabGroupRef>;

/**
 * `original` is what was typed; `address` is what quotes use (the correction, when the check made
 * one). `locked`: a run has quoted it, so the address can't change any more (decision 5).
 */
export const LabAddress = z.object({
  id: Id,
  title: z.string(),
  description: z.string().nullable(),
  original: LabAddressValue,
  address: LabAddressValue,
  residential: z.boolean(),
  checkStatus: ShipToStatus,
  checkMessages: z.array(z.string()),
  checkedAt: z.date().nullable(),
  locked: z.boolean(),
  archived: z.boolean(),
  groups: z.array(LabGroupRef),
  lastQuotedAt: z.date().nullable(),
});
export type LabAddress = z.infer<typeof LabAddress>;

const Title = text(80);
const Description = z
  .string()
  .trim()
  .max(500)
  .transform((value) => value || null)
  .nullable();
const GroupIds = z
  .array(Id)
  .max(50)
  .transform((ids) => [...new Set(ids)]);

export const ListLabAddressesInput = z.object({
  /** Addresses in any of these groups; empty = all. */
  groupIds: z.array(Id).max(50).default([]),
  includeArchived: z.boolean().default(false),
  search: z.string().trim().max(80).default(""),
});
export type ListLabAddressesInput = z.input<typeof ListLabAddressesInput>;

export const CreateLabAddressInput = z.object({
  idempotencyKey: IdempotencyKey,
  title: Title,
  description: Description.default(null),
  address: LabShipAddress,
  groupIds: GroupIds.default([]),
});
export type CreateLabAddressInput = z.input<typeof CreateLabAddressInput>;

/** Only the fields present change. `address` is refused once locked, unless it's unchanged. */
export const UpdateLabAddressInput = z.object({
  id: Id,
  title: Title.optional(),
  description: Description.optional(),
  address: LabShipAddress.optional(),
  groupIds: GroupIds.optional(),
});
export type UpdateLabAddressInput = z.input<typeof UpdateLabAddressInput>;

export const DuplicateLabAddressInput = z.object({ idempotencyKey: IdempotencyKey, id: Id });
export type DuplicateLabAddressInput = z.input<typeof DuplicateLabAddressInput>;

// Parcels: a size (from a box, or typed), a weight and optional contents (decision 4).

export const LabParcelItem = z.object({
  product: z.object({ id: Id, name: z.string(), sku: z.string().nullable() }),
  quantity: z.number().int(),
});
export type LabParcelItem = z.infer<typeof LabParcelItem>;

/**
 * `box` is the box it was made from: its inner size was copied then, and a later box edit doesn't
 * change the parcel. `locked`: a run has quoted it, so size, weight and contents are frozen.
 */
export const LabParcel = z.object({
  id: Id,
  title: z.string(),
  description: z.string().nullable(),
  box: z.object({ id: Id, name: z.string() }).nullable(),
  lengthIn: z.number(),
  widthIn: z.number(),
  heightIn: z.number(),
  weightOz: z.number(),
  items: z.array(LabParcelItem),
  locked: z.boolean(),
  archived: z.boolean(),
  groups: z.array(LabGroupRef),
  lastQuotedAt: z.date().nullable(),
});
export type LabParcel = z.infer<typeof LabParcel>;

/** A box (its inner size is copied) or a typed size, never both. */
export const LabParcelSize = z
  .object({
    boxId: Id.nullable().default(null),
    lengthIn: Inches.nullable().default(null),
    widthIn: Inches.nullable().default(null),
    heightIn: Inches.nullable().default(null),
  })
  .superRefine((size, ctx) => {
    const typed = (["lengthIn", "widthIn", "heightIn"] as const).filter((d) => size[d] !== null);
    if (size.boxId !== null) {
      if (typed.length > 0) {
        ctx.addIssue({ code: "custom", path: ["boxId"], message: "errors.rateLab.boxOrSize" });
      }
      return;
    }
    for (const dimension of ["lengthIn", "widthIn", "heightIn"] as const) {
      if (size[dimension] === null) {
        ctx.addIssue({ code: "custom", path: [dimension], message: "errors.field.required" });
      }
    }
  });
export type LabParcelSize = z.input<typeof LabParcelSize>;

/** Each product once, 1–999 of it. Only physical products are accepted (checked by the service). */
export const LabParcelItems = z
  .array(z.object({ productId: Id, quantity: z.number().int().min(1).max(999) }))
  .max(50)
  .superRefine((items, ctx) => {
    const seen = new Set<string>();
    items.forEach((item, index) => {
      if (seen.has(item.productId)) {
        ctx.addIssue({
          code: "custom",
          path: [index, "productId"],
          message: "errors.rateLab.itemDuplicate",
        });
      }
      seen.add(item.productId);
    });
  });
export type LabParcelItems = z.input<typeof LabParcelItems>;

export const ListLabParcelsInput = ListLabAddressesInput;
export type ListLabParcelsInput = z.input<typeof ListLabParcelsInput>;

export const CreateLabParcelInput = z.object({
  idempotencyKey: IdempotencyKey,
  title: Title,
  description: Description.default(null),
  size: LabParcelSize,
  weightOz: Ounces,
  items: LabParcelItems.default([]),
  groupIds: GroupIds.default([]),
});
export type CreateLabParcelInput = z.input<typeof CreateLabParcelInput>;

/**
 * Only the fields present change. Size, weight and items are refused once locked, unless they're
 * unchanged. The parcel's own box keeps the size it copied; picking another box copies its size.
 */
export const UpdateLabParcelInput = z.object({
  id: Id,
  title: Title.optional(),
  description: Description.optional(),
  size: LabParcelSize.optional(),
  weightOz: Ounces.optional(),
  items: LabParcelItems.optional(),
  groupIds: GroupIds.optional(),
});
export type UpdateLabParcelInput = z.input<typeof UpdateLabParcelInput>;

export const DuplicateLabParcelInput = DuplicateLabAddressInput;
export type DuplicateLabParcelInput = z.input<typeof DuplicateLabParcelInput>;

/** A physical product a parcel can hold. */
export const LabParcelProduct = LabParcelItem.shape.product;
export type LabParcelProduct = z.infer<typeof LabParcelProduct>;

export const ListLabParcelProductsInput = z.object({ search: z.string().trim().max(80) });
export type ListLabParcelProductsInput = z.input<typeof ListLabParcelProductsInput>;

export const ListLabGroupsInput = z.object({
  kind: RateLabGroupKind,
  includeArchived: z.boolean().default(false),
});
export type ListLabGroupsInput = z.input<typeof ListLabGroupsInput>;

const GroupName = text(60);

export const CreateLabGroupInput = z.object({
  idempotencyKey: IdempotencyKey,
  kind: RateLabGroupKind,
  name: GroupName,
});
export type CreateLabGroupInput = z.input<typeof CreateLabGroupInput>;

export const RenameLabGroupInput = z.object({ id: Id, name: GroupName });
export type RenameLabGroupInput = z.input<typeof RenameLabGroupInput>;

// Suite runs: addresses × parcels through every enabled provider (SPEC-rate-lab "Runs").

const Ids = z.array(Id).max(500).default([]);

/** What a run quotes. Empty lists on a side mean every active item of that side. */
export const LabRunSelection = z.object({
  addressGroupIds: Ids,
  addressIds: Ids,
  parcelGroupIds: Ids,
  parcelIds: Ids,
});
export type LabRunSelection = z.infer<typeof LabRunSelection>;

export const PreviewLabRunInput = z.object({ selection: LabRunSelection });
export type PreviewLabRunInput = z.input<typeof PreviewLabRunInput>;

export const LabRunPreview = z.object({
  addresses: z.number().int(),
  parcels: z.number().int(),
  combinations: z.number().int(),
  cap: z.number().int(),
  overCap: z.boolean(),
});
export type LabRunPreview = z.infer<typeof LabRunPreview>;

export const StartLabRunInput = z.object({
  idempotencyKey: IdempotencyKey,
  selection: LabRunSelection,
});
export type StartLabRunInput = z.input<typeof StartLabRunInput>;

export const RateLabRunKind = z.enum(["SUITE", "ONE_OFF"]);
export const RateLabRunStatus = z.enum([
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
  "PARTIAL",
  "FAILED",
  "CANCELLED",
]);
export type RateLabRunStatus = z.infer<typeof RateLabRunStatus>;

/** The side of a selection as the runs list shows it: the groups, and how many items were picked. */
const SelectionSide = z.object({ groups: z.array(LabGroupRef), items: z.number().int() });

export const LabRunRow = z.object({
  id: Id,
  kind: RateLabRunKind,
  status: RateLabRunStatus,
  startedBy: z.object({ id: Id, name: z.string() }).nullable(),
  createdAt: z.date(),
  startedAt: z.date().nullable(),
  finishedAt: z.date().nullable(),
  combinations: z.number().int(),
  completedCombinations: z.number().int(),
  quoteCount: z.number().int(),
  failureCount: z.number().int(),
  fake: z.boolean(),
  /** Message key of a whole-run failure. */
  error: z.string().nullable(),
  addresses: SelectionSide,
  parcels: SelectionSide,
});
export type LabRunRow = z.infer<typeof LabRunRow>;

export const LAB_RUNS_PAGE_MAX = 100;

export const ListLabRunsInput = z.object({
  /** `nextCursor` of the previous page. Opaque. */
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(LAB_RUNS_PAGE_MAX).default(25),
});
export type ListLabRunsInput = z.input<typeof ListLabRunsInput>;

export const LabRunPage = z.object({
  rows: z.array(LabRunRow),
  nextCursor: z.string().nullable(),
});
export type LabRunPage = z.infer<typeof LabRunPage>;

const byId = z.object({ id: Id });
const tags = ["Rate Lab"];

export const rateLab = {
  addresses: base
    .route({ method: "GET", path: "/rate-lab/addresses", tags, summary: "List test addresses" })
    .input(ListLabAddressesInput)
    .output(z.array(LabAddress)),

  createAddress: base
    .route({
      method: "POST",
      path: "/rate-lab/addresses",
      tags,
      summary: "Add a test address; it's checked on save",
    })
    .input(CreateLabAddressInput)
    .output(LabAddress),

  updateAddress: base
    .route({
      method: "PATCH",
      path: "/rate-lab/addresses/{id}",
      tags,
      summary: "Edit a test address",
    })
    .input(UpdateLabAddressInput)
    .output(LabAddress),

  recheckAddress: base
    .route({
      method: "POST",
      path: "/rate-lab/addresses/{id}/recheck",
      tags,
      summary: "Check a test address again",
    })
    .input(byId)
    .output(LabAddress),

  duplicateAddress: base
    .route({
      method: "POST",
      path: "/rate-lab/addresses/{id}/duplicate",
      tags,
      summary: "Copy a test address, unlocked",
    })
    .input(DuplicateLabAddressInput)
    .output(LabAddress),

  archiveAddress: base
    .route({
      method: "POST",
      path: "/rate-lab/addresses/{id}/archive",
      tags,
      summary: "Archive a test address",
    })
    .input(byId)
    .output(LabAddress),

  unarchiveAddress: base
    .route({
      method: "POST",
      path: "/rate-lab/addresses/{id}/unarchive",
      tags,
      summary: "Unarchive a test address",
    })
    .input(byId)
    .output(LabAddress),

  parcels: base
    .route({ method: "GET", path: "/rate-lab/parcels", tags, summary: "List test parcels" })
    .input(ListLabParcelsInput)
    .output(z.array(LabParcel)),

  createParcel: base
    .route({ method: "POST", path: "/rate-lab/parcels", tags, summary: "Add a test parcel" })
    .input(CreateLabParcelInput)
    .output(LabParcel),

  updateParcel: base
    .route({ method: "PATCH", path: "/rate-lab/parcels/{id}", tags, summary: "Edit a test parcel" })
    .input(UpdateLabParcelInput)
    .output(LabParcel),

  duplicateParcel: base
    .route({
      method: "POST",
      path: "/rate-lab/parcels/{id}/duplicate",
      tags,
      summary: "Copy a test parcel, unlocked",
    })
    .input(DuplicateLabParcelInput)
    .output(LabParcel),

  archiveParcel: base
    .route({
      method: "POST",
      path: "/rate-lab/parcels/{id}/archive",
      tags,
      summary: "Archive a test parcel",
    })
    .input(byId)
    .output(LabParcel),

  unarchiveParcel: base
    .route({
      method: "POST",
      path: "/rate-lab/parcels/{id}/unarchive",
      tags,
      summary: "Unarchive a test parcel",
    })
    .input(byId)
    .output(LabParcel),

  parcelProducts: base
    .route({
      method: "GET",
      path: "/rate-lab/parcel-products",
      tags,
      summary: "Find physical products to put in a test parcel",
    })
    .input(ListLabParcelProductsInput)
    .output(z.array(LabParcelProduct)),

  groups: base
    .route({ method: "GET", path: "/rate-lab/groups", tags, summary: "List groups of a kind" })
    .input(ListLabGroupsInput)
    .output(z.array(LabGroup)),

  createGroup: base
    .route({ method: "POST", path: "/rate-lab/groups", tags, summary: "Create a group" })
    .input(CreateLabGroupInput)
    .output(LabGroup),

  renameGroup: base
    .route({ method: "PATCH", path: "/rate-lab/groups/{id}", tags, summary: "Rename a group" })
    .input(RenameLabGroupInput)
    .output(LabGroup),

  archiveGroup: base
    .route({
      method: "POST",
      path: "/rate-lab/groups/{id}/archive",
      tags,
      summary: "Archive a group",
    })
    .input(byId)
    .output(LabGroup),

  realOrders: base
    .route({
      method: "GET",
      path: "/rate-lab/real-orders",
      tags,
      summary: "What real orders paid for labels, and what else they were offered",
    })
    .input(RealOrdersInput)
    .output(RealOrders),

  previewRun: base
    .route({
      method: "POST",
      path: "/rate-lab/runs/preview",
      tags,
      summary: "Count the combinations a run would quote",
    })
    .input(PreviewLabRunInput)
    .output(LabRunPreview),

  startRun: base
    .route({ method: "POST", path: "/rate-lab/runs", tags, summary: "Start a suite run" })
    .input(StartLabRunInput)
    .output(LabRunRow),

  runs: base
    .route({ method: "GET", path: "/rate-lab/runs", tags, summary: "Suite runs, newest first" })
    .input(ListLabRunsInput)
    .output(LabRunPage),
};
