import type { Role } from "@woolrus/db";
import { AppError } from "./errors";

/**
 * Who is acting. Every service function takes one; there is no ambient "current user".
 * `stationId` is set when the action came from a shared floor station.
 */
export type UserActor = {
  userId: string;
  roles: readonly Role[];
  stationId: string | null;
  /** The API call this actor was resolved for; audit rows record it. Absent outside a request. */
  requestId?: string;
  system?: undefined;
};

/** Background jobs acting on their own (SPEC-store-sync "System actor"). Never built from a request. */
export type SystemActor = {
  userId: null;
  roles: readonly Role[];
  stationId: null;
  requestId?: undefined;
  system: "store-sync" | "operations" | "shipping" | "lumexia";
};

export type Actor = UserActor | SystemActor;

/**
 * Store sync's actor: audit rows and stage events get a null actorId and history shows "Store sync".
 * Claims compare user ids, so it never holds or takes one.
 */
export const systemActor: SystemActor = Object.freeze({
  userId: null,
  roles: Object.freeze(["ADMIN"] as const),
  stationId: null,
  system: "store-sync",
});

/** The PII purge's actor: its audit rows show no user and the name "operations". */
export const operationsActor: SystemActor = Object.freeze({
  userId: null,
  roles: Object.freeze(["ADMIN"] as const),
  stationId: null,
  system: "operations",
});

/** Shipping's actor for the Woo push and other background shipping work: audit rows show "shipping". */
export const shippingActor: SystemActor = Object.freeze({
  userId: null,
  roles: Object.freeze(["ADMIN"] as const),
  stationId: null,
  system: "shipping",
});

/** Lumexia's background work (the daily item refresh, lot validation): audit rows show "lumexia". */
export const lumexiaActor: SystemActor = Object.freeze({
  userId: null,
  roles: Object.freeze(["ADMIN"] as const),
  stationId: null,
  system: "lumexia",
});

export const permissions = [
  "box.read",
  "box.manage",
  "order.read",
  "order.pick",
  "order.pack",
  /** Send a Ready order back to packing; its labels are voided first. */
  "order.repack",
  "order.qa",
  "order.hold",
  "order.cancel",
  "order.forceStatus",
  "order.resolveExternalChange",
  "label.purchase",
  "label.print",
  "label.void",
  /** Give up on a label whose void is stuck, leaving it out of the live set. */
  "label.writeOff",
  "order.ship",
  "note.write",
  /** Write to the customer: create a customer-visible note or switch one to it. */
  "note.customer",
  "note.moderate",
  "issue.report",
  "issue.resolve",
  "issue.delete",
  "void.create",
  "void.resolve",
  "settings.manage",
  "user.manage",
  "station.manage",
  "report.read",
  /** Catalog data the warehouse owns, e.g. linking a scanned barcode to a product. */
  "product.manage",
  /** The failed-jobs page: see, retry and dismiss background jobs that gave up. */
  "ops.jobs",
  /** Rate Lab: run price tests, get one-off quotes, read runs and trends (SPEC-rate-lab). */
  "ratelab.use",
  /** Rate Lab: manage test addresses, parcels and groups. */
  "ratelab.manage",
  /** Lumexia: test the connection, link products to items, set lot rules (SPEC-lumexia). */
  "lumexia.manage",
] as const;
export type Permission = (typeof permissions)[number];

const everyone: Permission[] = [
  "box.read",
  "order.read",
  "order.hold",
  "note.write",
  "issue.report",
  "void.create",
];

export const rolePermissions: Record<Role, readonly Permission[]> = {
  ADMIN: permissions,
  PICKER: [...everyone, "order.pick"],
  PACKER: [...everyone, "order.pack"],
  QA: [
    ...everyone,
    "order.qa",
    "order.repack",
    "label.purchase",
    "label.void",
    "label.print",
    "note.customer",
  ],
  SHIPPER: [...everyone, "label.print", "order.ship", "order.repack", "note.customer"],
  // Ticked on any user next to their other roles (SPEC-rate-lab decision 13); no other role has it.
  RATE_LAB: [...everyone, "ratelab.use", "ratelab.manage"],
};

export function permissionsFor(roles: readonly Role[]): Permission[] {
  return [...new Set(roles.flatMap((role) => rolePermissions[role]))].sort();
}

export function can(actor: Actor, permission: Permission): boolean {
  return actor.roles.some((role) => rolePermissions[role].includes(permission));
}

/** Deny by default: call at the top of every service function. */
export function assertCan(actor: Actor, permission: Permission): void {
  if (!can(actor, permission)) throw new AppError("FORBIDDEN", "errors.forbidden");
}
