import { z } from "zod";
import { base, Id, IdempotencyKey } from "./base";
import { ShipToStatus } from "./carriers";
import { RealOrders, RealOrdersInput } from "./rate-lab-real-orders";

// Rate Lab (SPEC-rate-lab): test addresses and the groups that tag them. Parcels and runs join
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
};
