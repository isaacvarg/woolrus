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
  system?: undefined;
};

/** Background jobs acting on their own (SPEC-store-sync "System actor"). Never built from a request. */
export type SystemActor = {
  userId: null;
  roles: readonly Role[];
  stationId: null;
  system: "store-sync";
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

export const permissions = [
  "box.read",
  "box.manage",
  "order.read",
  "order.pick",
  "order.pack",
  "order.qa",
  "order.hold",
  "order.cancel",
  "order.forceStatus",
  "order.resolveExternalChange",
  "label.purchase",
  "label.print",
  "label.void",
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
  QA: [...everyone, "order.qa", "label.purchase", "label.print", "note.customer"],
  SHIPPER: [...everyone, "label.print", "order.ship", "note.customer"],
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
